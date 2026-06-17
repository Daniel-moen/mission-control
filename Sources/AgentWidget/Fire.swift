import SwiftUI

// MARK: - FireView

/// Living fire for the Burn tab. `intensity` (0…1) sets the steady-state
/// ferocity; `level` is the realtime token total — each increase triggers a
/// visible flare that decays back to baseline over ~0.9 s, with bigger jumps
/// producing bigger flares.
struct FireView: View {
    var intensity: Double   // 0…1 steady-state ferocity (already computed by BurnView)
    var level: Int          // the live, realtime-updating token total (summary.totalTokens)
    /// Whether the fire should actually animate. Driven by BurnView from "is the
    /// fleet live + is the popover visible" — when false the 30fps Canvas
    /// freezes on a static frame instead of churning while nothing is burning or
    /// nobody is watching.
    var animate: Bool = true

    @State private var flareStart: Date = .distantPast
    @State private var flareMag: Double = 0
    @State private var lastLevel: Int = 0

    // Layered tongues: a darker, wider back wall for depth and a brighter,
    // sharper front rank that reads as the live flame. Ember/spark counts are
    // scaled by energy/flare so a quiet fire stays cheap to draw.
    private let backTongues  = 6
    private let frontTongues = 8
    private let emberCount   = 64
    private let sparkCount   = 18

    var body: some View {
        // 24fps reads as smooth for fire while cutting a fifth of the Canvas work.
        TimelineView(.animation(minimumInterval: 1.0 / 24.0, paused: !animate)) { timeline in
            let t       = timeline.date.timeIntervalSinceReferenceDate
            let elapsed = max(0, timeline.date.timeIntervalSince(flareStart))
            let flare   = FireView.flareCurve(elapsed) * flareMag
            let energy  = min(1.0, max(0.04, intensity) + flare * 0.55)

            Canvas { ctx, size in
                let w = size.width, h = size.height
                drawGlowBed(ctx: ctx, w: w, h: h, t: t, energy: energy, flare: flare)
                drawTongues(ctx: ctx, w: w, h: h, t: t, energy: energy, flare: flare,
                            count: backTongues, layer: .back)
                drawEmbers(ctx: ctx, w: w, h: h, t: t, energy: energy)
                drawTongues(ctx: ctx, w: w, h: h, t: t, energy: energy, flare: flare,
                            count: frontTongues, layer: .front)
                if flare > 0.04 {
                    drawSparks(ctx: ctx, w: w, h: h, t: t, flare: flare)
                }
                drawHotCore(ctx: ctx, w: w, h: h, t: t, energy: energy, flare: flare)
            }
        }
        .onChange(of: level) { newLevel in
            let delta = newLevel - lastLevel
            if delta > 0 {
                // Scale flare by delta: a ~4k-token tick = modest flare; 30k+ = max.
                let mag = min(1.0, Double(delta) / 4000.0)
                // Blend: if a flare is already in flight keep some of its momentum.
                flareMag  = min(1.0, max(flareMag * 0.25, mag))
                flareStart = .now
            }
            lastLevel = newLevel
        }
        .onAppear { lastLevel = level }
    }

    // MARK: - Glow bed

    /// The warm pool of light the whole fire sits in: overlapping radial blooms
    /// pulsing along the base, plus one broad updraft glow that lifts on a flare.
    private func drawGlowBed(ctx: GraphicsContext, w: CGFloat, h: CGFloat,
                              t: Double, energy: Double, flare: Double) {
        // Broad ambient updraft — a tall, soft column of heat behind everything.
        let updR = w * (0.55 + 0.25 * energy + 0.2 * flare)
        let updCx = w * 0.5 + sin(t * 0.7) * w * 0.02
        let updCy = h + updR * 0.18 - flare * h * 0.10
        ctx.fill(
            Circle().path(in: CGRect(x: updCx - updR, y: updCy - updR,
                                     width: 2 * updR, height: 2 * updR)),
            with: .radialGradient(
                Gradient(colors: [
                    Color(hue: 0.055, saturation: 1.0, brightness: 1)
                        .opacity(0.10 + 0.18 * energy + 0.12 * flare),
                    .clear,
                ]),
                center: CGPoint(x: updCx, y: updCy), startRadius: 0, endRadius: updR))

        for i in 0..<11 {
            let p     = Double(i) / 10.0
            let flick = 0.5 + 0.5 * sin(t * (2.1 + Double(i) * 0.75) + Double(i) * 1.85)
            let cx    = w * (0.03 + 0.94 * p) + sin(t * 1.1 + Double(i) * 0.9) * w * 0.03
            let r     = w * 0.18 * (0.45 + 0.75 * flick) * (0.5 + energy + flare * 0.3)
            let cy    = h - r * 0.08
            let hue   = 0.015 + 0.05 * flick
            let col   = Color(hue: hue, saturation: 0.97, brightness: 1.0)
            ctx.fill(
                Circle().path(in: CGRect(x: cx - r, y: cy - r, width: 2 * r, height: 2 * r)),
                with: .radialGradient(
                    Gradient(colors: [col.opacity(0.12 + 0.50 * energy + 0.2 * flare), .clear]),
                    center: CGPoint(x: cx, y: cy), startRadius: 0, endRadius: r))
        }
    }

    // MARK: - Flame tongues

    private enum TongueLayer { case back, front }

    /// Draws a rank of wavering flame tongues. Each tongue is a teardrop bezier
    /// whose tip sways and whose sides wobble over time, filled with a
    /// base→tip heat gradient. The front layer adds a bright inner lick.
    private func drawTongues(ctx: GraphicsContext, w: CGFloat, h: CGFloat,
                             t: Double, energy: Double, flare: Double,
                             count: Int, layer: TongueLayer) {
        let isFront = layer == .front
        for i in 0..<count {
            let seed  = FireView.frac(Double(i) * 0.61803398875 + (isFront ? 0.0 : 0.27))
            let seed2 = FireView.frac(Double(i) * 0.38196601125 + 0.15)
            let seed3 = FireView.frac(Double(i) * 0.20871215252 + 0.42)

            // Back rank spreads wider; front rank clusters toward the centre.
            let spread = isFront ? 0.86 : 0.96
            let baseX  = w * ((1 - spread) / 2 + spread * seed)
            let flickF = isFront ? 1.7 : 1.35
            let flick  = 0.5 + 0.5 * sin(t * (flickF + seed * 1.5) + seed2 * 6.28)
            // Independent sway streams give the two layers a parallax shimmer.
            let swayAmp = isFront ? 0.06 : 0.085
            let sway    = sin(t * (isFront ? 1.25 : 0.95) + seed * 4.1) * w * swayAmp
                        + cos(t * (isFront ? 0.8 : 0.6) + seed3 * 3.1) * w * 0.022

            let maxH    = h * ((isFront ? 0.58 : 0.70) + 0.26 * energy + 0.30 * flare)
            let tongueH = maxH * (0.42 + 0.58 * flick)
            let tongueW = w * ((isFront ? 0.085 : 0.12) + 0.06 * seed)

            // Side wobble so the silhouette breathes rather than staying elliptic.
            let wobbleL = sin(t * 3.1 + seed * 7.0) * tongueW * 0.22
            let wobbleR = sin(t * 2.7 + seed2 * 7.0 + 1.6) * tongueW * 0.22

            let path = FireView.flamePath(baseX: baseX, baseW: tongueW, height: tongueH,
                                          sway: sway, wobbleL: wobbleL, wobbleR: wobbleR, h: h)

            let tipY = h - tongueH
            if isFront {
                // Front rank: saturated yellow→orange→red, fairly opaque + bright.
                var c = ctx
                c.opacity = (0.24 + 0.40 * energy) * (0.6 + 0.4 * flick)
                c.fill(path, with: .linearGradient(
                    Gradient(stops: [
                        .init(color: Color(hue: 0.14, saturation: 0.62, brightness: 1).opacity(0.97), location: 0.0),
                        .init(color: Color(hue: 0.085, saturation: 0.95, brightness: 1).opacity(0.78), location: 0.40),
                        .init(color: Color(hue: 0.02, saturation: 0.92, brightness: 0.92).opacity(0.34), location: 0.78),
                        .init(color: .clear, location: 1.0),
                    ]),
                    startPoint: CGPoint(x: baseX, y: h),
                    endPoint:   CGPoint(x: baseX + sway, y: tipY)))

                // Bright narrow inner lick for the hottest core of the flame.
                let innerW = tongueW * 0.4
                let innerH = tongueH * 0.66
                let innerPath = FireView.flamePath(baseX: baseX, baseW: innerW, height: innerH,
                                                   sway: sway * 1.15, wobbleL: wobbleL * 0.5,
                                                   wobbleR: wobbleR * 0.5, h: h)
                var c2 = ctx
                c2.opacity = (0.30 + 0.32 * energy) * flick
                c2.fill(innerPath, with: .linearGradient(
                    Gradient(stops: [
                        .init(color: .white.opacity(0.9), location: 0.0),
                        .init(color: Color(hue: 0.13, saturation: 0.55, brightness: 1).opacity(0.6), location: 0.5),
                        .init(color: .clear, location: 1.0),
                    ]),
                    startPoint: CGPoint(x: baseX, y: h),
                    endPoint:   CGPoint(x: baseX + sway, y: h - innerH)))
            } else {
                // Back rank: deeper, cooler reds, softer and more transparent —
                // pure depth so the front rank pops in front of it.
                var c = ctx
                c.opacity = (0.16 + 0.26 * energy) * (0.6 + 0.4 * flick)
                c.fill(path, with: .linearGradient(
                    Gradient(stops: [
                        .init(color: Color(hue: 0.07, saturation: 0.9, brightness: 1).opacity(0.8), location: 0.0),
                        .init(color: Color(hue: 0.02, saturation: 0.95, brightness: 0.85).opacity(0.5), location: 0.55),
                        .init(color: Color(hue: 0.0, saturation: 1.0, brightness: 0.6).opacity(0.18), location: 0.85),
                        .init(color: .clear, location: 1.0),
                    ]),
                    startPoint: CGPoint(x: baseX, y: h),
                    endPoint:   CGPoint(x: baseX + sway, y: tipY)))
            }
        }
    }

    /// A teardrop flame silhouette: base segment, left edge sweeping up to a
    /// swaying tip, right edge sweeping back down. Control points carry the
    /// per-frame wobble so the edges ripple like real flame.
    private static func flamePath(baseX: CGFloat, baseW: CGFloat, height: CGFloat,
                                  sway: CGFloat, wobbleL: CGFloat, wobbleR: CGFloat,
                                  h: CGFloat) -> Path {
        var p = Path()
        let half  = baseW / 2
        let tipX  = baseX + sway
        let tipY  = h - height
        let leftX  = baseX - half
        let rightX = baseX + half
        p.move(to: CGPoint(x: leftX, y: h))
        // Left edge up to the tip, pinching inward as it rises.
        p.addCurve(to: CGPoint(x: tipX, y: tipY),
                   control1: CGPoint(x: leftX + wobbleL, y: h - height * 0.40),
                   control2: CGPoint(x: tipX - half * 0.45 + wobbleL, y: h - height * 0.82))
        // Right edge back down to the base.
        p.addCurve(to: CGPoint(x: rightX, y: h),
                   control1: CGPoint(x: tipX + half * 0.45 + wobbleR, y: h - height * 0.82),
                   control2: CGPoint(x: rightX + wobbleR, y: h - height * 0.40))
        // Rounded base so tongues don't look chopped at the floor.
        p.addQuadCurve(to: CGPoint(x: leftX, y: h),
                       control: CGPoint(x: baseX, y: h + height * 0.05))
        p.closeSubpath()
        return p
    }

    // MARK: - Rising embers

    private func drawEmbers(ctx: GraphicsContext, w: CGFloat, h: CGFloat,
                             t: Double, energy: Double) {
        let active = max(2, Int(Double(emberCount) * energy))
        for i in 0..<active {
            let seed  = FireView.frac(Double(i) * 0.61803398875)
            let seed2 = FireView.frac(Double(i) * 0.75487766620 + 0.31)
            let seed3 = FireView.frac(Double(i) * 0.56984029100 + 0.67)

            let speed = 0.15 + seed * 0.32
            let life  = FireView.frac(t * speed + seed)   // 0 = base, 1 = top

            // Drift widens as embers rise and cool, with a little turbulence.
            let sway = sin(life * 7.2 + seed * 6.28) * w * (0.04 + life * 0.05)
                     + cos(life * 4.1 + seed3 * 3.14) * w * 0.025
            let x = w * (0.05 + 0.90 * seed2) + sway
            let y = h - life * h * (0.62 + 0.40 * energy)

            let sz = (1.4 + seed * 4.2) * (1 - life * 0.78) * (0.65 + 0.65 * energy)

            // White-hot at base, cools to deep red as it climbs.
            let hue = 0.14 * (1.0 - life * 0.88)
            let sat = 0.40 + 0.60 * life
            let bri = 1.0  - 0.20 * life
            let col = Color(hue: hue, saturation: sat, brightness: bri)
            let alpha = (1 - life * 0.82) * (0.36 + 0.64 * energy)

            // A soft-edged radial gradient gives each ember its glow without a
            // per-element `.blur` filter — blur in a Canvas forces an expensive
            // offscreen pass per draw, and we'd be doing dozens of them a frame.
            let r = sz * 1.6
            var c = ctx
            c.opacity = alpha
            c.fill(
                Circle().path(in: CGRect(x: x - r, y: y - r, width: 2 * r, height: 2 * r)),
                with: .radialGradient(Gradient(colors: [col, col.opacity(0.35), .clear]),
                                      center: CGPoint(x: x, y: y), startRadius: 0, endRadius: r))
        }
    }

    // MARK: - Flare sparks

    private func drawSparks(ctx: GraphicsContext, w: CGFloat, h: CGFloat,
                             t: Double, flare: Double) {
        let count = max(4, Int(Double(sparkCount) * flare))
        for i in 0..<count {
            let seed  = FireView.frac(Double(i) * 0.41421356237)
            let seed2 = FireView.frac(Double(i) * 0.30277563773 + 0.50)
            let seed3 = FireView.frac(Double(i) * 0.22360679775 + 0.25)

            let speed = 0.55 + seed * 0.90   // faster than embers
            let life  = FireView.frac(t * speed + seed)

            // Sparks spray outward from a cluster near the base centre.
            let angle   = (seed2 - 0.5) * .pi * 1.4   // roughly upward fan
            let dist    = life * h * (0.40 + 0.32 * flare) * (0.6 + 0.8 * seed)
            let cx      = w * (0.25 + 0.50 * seed3)
            let x       = cx    + sin(angle) * dist
            let y       = h * 0.92 - cos(angle) * dist - life * life * h * 0.18

            let sz = 1.9 * (1 - life) * (0.6 + 0.7 * flare)
            let col = Color(hue: 0.11 - 0.05 * life, saturation: 0.25 + 0.4 * life, brightness: 1)

            var c = ctx
            c.opacity = (1 - life) * flare * 0.9
            c.fill(
                Circle().path(in: CGRect(x: x - sz / 2, y: y - sz / 2, width: sz, height: sz)),
                with: .color(col))
        }
    }

    // MARK: - Hot core

    private func drawHotCore(ctx: GraphicsContext, w: CGFloat, h: CGFloat,
                              t: Double, energy: Double, flare: Double) {
        let cx   = w * 0.5
        let cy   = h - w * 0.04
        let flick = 0.55 + 0.45 * sin(t * 4.5 + 1.1)

        // Inner white-blue-yellow bloom — the hottest point of the blaze.
        let r = w * 0.28 * (0.65 + 0.35 * energy + 0.45 * flare) * (0.85 + 0.15 * flick)
        ctx.fill(
            Circle().path(in: CGRect(x: cx - r, y: cy - r, width: 2 * r, height: 2 * r)),
            with: .radialGradient(
                Gradient(stops: [
                    .init(color: .white.opacity(0.38 * energy + 0.40 * flare),               location: 0.0),
                    .init(color: Color(hue: 0.13, saturation: 0.5, brightness: 1)
                                    .opacity(0.30 * energy + 0.28 * flare),                   location: 0.28),
                    .init(color: Color(hue: 0.06, saturation: 0.95, brightness: 1)
                                    .opacity(0.16 * energy),                                  location: 0.62),
                    .init(color: .clear,                                                       location: 1.0),
                ]),
                center: CGPoint(x: cx, y: cy), startRadius: 0, endRadius: r))

        // Outer diffuse orange corona.
        let outerR = r * 2.2
        ctx.fill(
            Circle().path(in: CGRect(x: cx - outerR, y: cy - outerR,
                                     width: 2 * outerR, height: 2 * outerR)),
            with: .radialGradient(
                Gradient(colors: [
                    Color(hue: 0.06, saturation: 1.0, brightness: 1)
                        .opacity(0.06 + 0.16 * flare),
                    .clear,
                ]),
                center: CGPoint(x: cx, y: cy), startRadius: 0, endRadius: outerR))
    }

    // MARK: - Helpers

    private static func frac(_ x: Double) -> Double { x - floor(x) }

    /// Flare envelope: a fast attack (~0.09s) into a softened decay over ~0.9s,
    /// so a token burst snaps the fire upward then eases back rather than
    /// popping linearly. Returns 0…1.
    private static func flareCurve(_ elapsed: Double) -> Double {
        let attack = 0.09
        let decay  = 0.85
        if elapsed < 0 { return 0 }
        if elapsed < attack { return elapsed / attack }
        let d = elapsed - attack
        if d >= decay { return 0 }
        let k = 1 - d / decay
        return k * k * (1.1 - 0.1 * k)   // eased falloff, clamped to ≤1
    }
}
