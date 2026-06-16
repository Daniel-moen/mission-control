import SwiftUI

// MARK: - FireView

/// Living fire for the Burn tab. `intensity` (0…1) sets the steady-state
/// ferocity; `level` is the realtime token total — each increase triggers a
/// visible flare that decays back to baseline over ~0.8 s, with bigger jumps
/// producing bigger flares.
struct FireView: View {
    var intensity: Double   // 0…1 steady-state ferocity (already computed by BurnView)
    var level: Int          // the live, realtime-updating token total (summary.totalTokens)

    @State private var flareStart: Date = .distantPast
    @State private var flareMag: Double = 0
    @State private var lastLevel: Int = 0

    private let emberCount = 130
    private let sparkCount  = 28
    private let tongueCount = 9

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30.0)) { timeline in
            let t       = timeline.date.timeIntervalSinceReferenceDate
            let elapsed = max(0, timeline.date.timeIntervalSince(flareStart))
            let flare   = elapsed < 0.9 ? flareMag * max(0, 1 - elapsed / 0.9) : 0.0
            let energy  = min(1.0, max(0.04, intensity) + flare * 0.55)

            Canvas { ctx, size in
                let w = size.width, h = size.height
                drawGlowBed(ctx: ctx, w: w, h: h, t: t, energy: energy, flare: flare)
                drawFlameTongues(ctx: ctx, w: w, h: h, t: t, energy: energy, flare: flare)
                drawEmbers(ctx: ctx, w: w, h: h, t: t, energy: energy)
                if flare > 0.04 {
                    drawSparks(ctx: ctx, w: w, h: h, t: t, flare: flare)
                }
                drawHotCore(ctx: ctx, w: w, h: h, t: t, energy: energy, flare: flare)
            }
        }
        .onChange(of: level) { newLevel in
            let delta = newLevel - lastLevel
            if delta > 0 {
                // Scale flare by delta: a 3 k-token tick = modest flare; 30 k+ = max.
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

    private func drawGlowBed(ctx: GraphicsContext, w: CGFloat, h: CGFloat,
                              t: Double, energy: Double, flare: Double) {
        for i in 0..<10 {
            let p     = Double(i) / 9.0
            let flick = 0.5 + 0.5 * sin(t * (2.1 + Double(i) * 0.75) + Double(i) * 1.85)
            let cx    = w * (0.04 + 0.92 * p) + sin(t * 1.1 + Double(i) * 0.9) * w * 0.03
            let r     = w * 0.19 * (0.45 + 0.75 * flick) * (0.5 + energy + flare * 0.3)
            let cy    = h - r * 0.08
            let hue   = 0.02 + 0.045 * flick
            let col   = Color(hue: hue, saturation: 0.96, brightness: 1.0)
            ctx.fill(
                Circle().path(in: CGRect(x: cx - r, y: cy - r, width: 2 * r, height: 2 * r)),
                with: .radialGradient(
                    Gradient(colors: [col.opacity(0.12 + 0.52 * energy + 0.2 * flare), .clear]),
                    center: CGPoint(x: cx, y: cy), startRadius: 0, endRadius: r))
        }
    }

    // MARK: - Flame tongues

    private func drawFlameTongues(ctx: GraphicsContext, w: CGFloat, h: CGFloat,
                                   t: Double, energy: Double, flare: Double) {
        for i in 0..<tongueCount {
            let seed  = FireView.frac(Double(i) * 0.61803398875)
            let seed2 = FireView.frac(Double(i) * 0.38196601125 + 0.15)
            let seed3 = FireView.frac(Double(i) * 0.20871215252 + 0.42)

            let baseX = w * (0.04 + 0.92 * seed)
            let flick = 0.5 + 0.5 * sin(t * (1.7 + seed * 1.5) + seed2 * 6.28)
            let sway  = sin(t * 1.25 + seed * 4.1) * w * 0.055
                      + cos(t * 0.8  + seed3 * 3.1) * w * 0.02

            let maxH   = h * (0.62 + 0.28 * energy + 0.28 * flare)
            let tongueH = maxH * (0.45 + 0.55 * flick)
            let tongueW = w * (0.09 + 0.06 * seed)
            let tipX    = baseX + sway
            let tipY    = h - tongueH

            // Ellipse path for the tongue silhouette
            let rect = CGRect(x: baseX - tongueW / 2 + sway * 0.35,
                              y: tipY, width: tongueW, height: tongueH)

            // gradient: yellow-white at base → orange mid → red tip → clear
            let baseColor = Color(hue: 0.13,  saturation: 0.65, brightness: 1.0)
            let midColor  = Color(hue: 0.07,  saturation: 0.95, brightness: 1.0)
            let tipColor  = Color(hue: 0.015, saturation: 0.90, brightness: 0.85)

            var c = ctx
            c.opacity = (0.22 + 0.38 * energy) * (0.6 + 0.4 * flick)
            c.fill(
                Ellipse().path(in: rect),
                with: .linearGradient(
                    Gradient(stops: [
                        .init(color: baseColor.opacity(0.95), location: 0.0),
                        .init(color: midColor.opacity(0.70),  location: 0.45),
                        .init(color: tipColor.opacity(0.25),  location: 0.80),
                        .init(color: .clear,                  location: 1.0),
                    ]),
                    startPoint: CGPoint(x: baseX, y: h),
                    endPoint:   CGPoint(x: tipX,  y: tipY)))

            // Brighter, narrower inner tongue for the hot lick
            let innerW = tongueW * 0.38
            let innerH = tongueH * 0.65
            let innerRect = CGRect(x: baseX - innerW / 2 + sway * 0.5,
                                   y: h - innerH, width: innerW, height: innerH)
            var c2 = ctx
            c2.opacity = (0.28 + 0.30 * energy) * flick
            c2.fill(
                Ellipse().path(in: innerRect),
                with: .linearGradient(
                    Gradient(stops: [
                        .init(color: .white.opacity(0.85),                         location: 0.0),
                        .init(color: Color(hue: 0.12, saturation: 0.6, brightness: 1).opacity(0.6), location: 0.5),
                        .init(color: .clear,                                        location: 1.0),
                    ]),
                    startPoint: CGPoint(x: baseX, y: h),
                    endPoint:   CGPoint(x: tipX,  y: h - innerH)))
        }
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

            let sway = sin(life * 7.2 + seed * 6.28) * w * 0.055
                     + cos(life * 4.1 + seed3 * 3.14) * w * 0.025
            let x = w * (0.05 + 0.90 * seed2) + sway
            let y = h - life * h * (0.60 + 0.40 * energy)

            let sz = (1.5 + seed * 4.0) * (1 - life * 0.75) * (0.65 + 0.65 * energy)

            // White-hot at base, cools to deep red as it climbs
            let hue = 0.14 * (1.0 - life * 0.85)
            let sat = 0.45 + 0.55 * life
            let bri = 1.0  - 0.22 * life

            var c = ctx
            c.opacity = (1 - life * 0.8) * (0.38 + 0.62 * energy)
            c.addFilter(.blur(radius: 0.4 + sz * 0.12))
            c.fill(
                Circle().path(in: CGRect(x: x - sz / 2, y: y - sz / 2, width: sz, height: sz)),
                with: .color(Color(hue: hue, saturation: sat, brightness: bri)))
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

            // Sparks spray outward from a cluster near the base center
            let angle   = (seed2 - 0.5) * .pi * 1.4   // roughly upward fan
            let dist    = life * h * (0.38 + 0.30 * flare) * (0.6 + 0.8 * seed)
            let cx      = w * (0.25 + 0.50 * seed3)
            let x       = cx    + sin(angle) * dist
            let y       = h * 0.92 - cos(angle) * dist - life * life * h * 0.18

            let sz = 1.8 * (1 - life) * (0.6 + 0.7 * flare)

            var c = ctx
            c.opacity = (1 - life) * flare * 0.85
            c.fill(
                Circle().path(in: CGRect(x: x - sz / 2, y: y - sz / 2, width: sz, height: sz)),
                with: .color(.white))
        }
    }

    // MARK: - Hot core

    private func drawHotCore(ctx: GraphicsContext, w: CGFloat, h: CGFloat,
                              t: Double, energy: Double, flare: Double) {
        let cx   = w * 0.5
        let cy   = h - w * 0.04
        let flick = 0.55 + 0.45 * sin(t * 4.5 + 1.1)

        // Inner white-yellow bloom
        let r = w * 0.28 * (0.65 + 0.35 * energy + 0.45 * flare) * (0.85 + 0.15 * flick)
        ctx.fill(
            Circle().path(in: CGRect(x: cx - r, y: cy - r, width: 2 * r, height: 2 * r)),
            with: .radialGradient(
                Gradient(stops: [
                    .init(color: .white.opacity(0.35 * energy + 0.35 * flare),              location: 0.0),
                    .init(color: Color(hue: 0.12, saturation: 0.65, brightness: 1)
                                    .opacity(0.28 * energy + 0.25 * flare),                  location: 0.30),
                    .init(color: Color(hue: 0.06, saturation: 0.95, brightness: 1)
                                    .opacity(0.14 * energy),                                  location: 0.65),
                    .init(color: .clear,                                                       location: 1.0),
                ]),
                center: CGPoint(x: cx, y: cy), startRadius: 0, endRadius: r))

        // Outer diffuse orange corona
        let outerR = r * 2.2
        ctx.fill(
            Circle().path(in: CGRect(x: cx - outerR, y: cy - outerR,
                                     width: 2 * outerR, height: 2 * outerR)),
            with: .radialGradient(
                Gradient(colors: [
                    Color(hue: 0.06, saturation: 1.0, brightness: 1)
                        .opacity(0.06 + 0.14 * flare),
                    .clear,
                ]),
                center: CGPoint(x: cx, y: cy), startRadius: 0, endRadius: outerR))
    }

    // MARK: - Helpers

    private static func frac(_ x: Double) -> Double { x - floor(x) }
}
