import SwiftUI

// MARK: - Aurora background

/// A slow, living aurora that drifts behind the whole window. Layered obsidian
/// base + several softly blended light ribbons tinted by the fleet's dominant
/// state, so the app subtly "feels" busy when agents work and cools when done.
/// Kept translucent so the frosted-glass popover shows the desktop through it.
struct AuroraBackground: View {
    var tint: Color
    var energy: Double   // 0…1, scales motion + brightness
    /// When false the gradient freezes on one frame instead of drifting at
    /// 20fps — used to stop the blur+drawingGroup churn while the fleet is idle
    /// or the popover is hidden. Brightness still tracks `energy`, so a paused
    /// aurora is just a static (still good-looking) backdrop.
    var animate: Bool = true

    /// Cooler companion hues that keep the aurora from reading as a single flat
    /// wash — a deep indigo and the brand purple weave through the state tint.
    private let indigo = Color(red: 0.16, green: 0.20, blue: 0.45)

    var body: some View {
        ZStack {
            // Translucent obsidian base: deep at the bottom, a touch of lift up
            // top so the glass has a sense of an horizon. Partly see-through so
            // the behind-window blur reads as real glass.
            LinearGradient(colors: [Color(red: 0.05, green: 0.06, blue: 0.11).opacity(0.62),
                                    Color(red: 0.02, green: 0.02, blue: 0.05).opacity(0.80)],
                           startPoint: .top, endPoint: .bottom)

            // Drifts slowly, so 12fps is indistinguishable from 60 and far cheaper
            // — this whole-window blur+drawingGroup pass is the priciest background
            // cost, so we redraw it as seldom as the slow motion allows.
            TimelineView(.animation(minimumInterval: 1.0 / 12.0, paused: !animate)) { timeline in
                let t = timeline.date.timeIntervalSinceReferenceDate
                Canvas { ctx, size in
                    ctx.fill(Path(CGRect(origin: .zero, size: size)),
                             with: .color(Color.black.opacity(0.001)))   // keep canvas opaque-ish
                    ctx.addFilter(.blur(radius: 26))
                    let blobs = 4
                    for i in 0..<blobs {
                        let fi = Double(i)
                        let phase = fi * 1.7
                        let speed = 0.10 + fi * 0.028
                        // Gentle Lissajous drift — slower & wider than before.
                        let cx = size.width  * (0.5 + 0.46 * sin(t * speed + phase))
                        let cy = size.height * (0.5 + 0.50 * cos(t * speed * 0.7 + phase * 1.2))
                        let r = size.width * (0.50 + 0.16 * sin(t * 0.22 + phase))
                        let hue: Color
                        switch i {
                        case 0: hue = tint
                        case 1: hue = tint.opacity(0.8)
                        case 2: hue = Color.purple
                        case 3: hue = indigo
                        default: hue = tint
                        }
                        let alpha = 0.16 + 0.20 * energy
                        let rect = CGRect(x: cx - r, y: cy - r, width: r * 2, height: r * 2)
                        ctx.fill(
                            Circle().path(in: rect),
                            with: .radialGradient(
                                Gradient(colors: [hue.opacity(alpha), .clear]),
                                center: CGPoint(x: cx, y: cy),
                                startRadius: 0, endRadius: r))
                    }
                }
            }
            .drawingGroup()
            .blendMode(.plusLighter)

            // Soft corner vignette to seat the glass and deepen the obsidian feel.
            RadialGradient(colors: [.clear, Color.black.opacity(0.28)],
                           center: .center, startRadius: 120, endRadius: 460)
                .blendMode(.multiply)
        }
        .opacity(0.94)
    }
}

// MARK: - Equalizer (the agent's heartbeat)

/// A row of bars that dance while an agent works, their height driven by sine
/// waves whose amplitude scales with how hard the agent is going. Flat and dim
/// when idle/done — so a glance tells you who's actually burning.
struct Equalizer: View {
    var color: Color
    var active: Bool
    var intensity: Double
    var bars: Int = 14
    /// Extra gate (e.g. popover visibility). The bars only dance while the agent
    /// is `active` *and* someone's watching; otherwise the TimelineView is paused
    /// and we render one static frame of flat, dim bars — no 30fps Canvas churn.
    var animate: Bool = true

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 20.0, paused: !(active && animate))) { timeline in
            let t = timeline.date.timeIntervalSinceReferenceDate
            Canvas { ctx, size in
                let gap: CGFloat = 2
                let bw = (size.width - gap * CGFloat(bars - 1)) / CGFloat(bars)
                let amp = active ? (0.25 + 0.75 * intensity) : 0.06
                // Add the glow once up front rather than re-adding it per bar
                // (each `addFilter` stacks an offscreen pass onto the context).
                if active {
                    ctx.addFilter(.shadow(color: color.opacity(0.5), radius: 2.5))
                }
                for i in 0..<bars {
                    let phase = Double(i) * 0.55
                    // Layer two waves so the dance feels organic, not metronomic.
                    let wave = 0.5 + 0.35 * sin(t * (active ? 6.0 : 0) + phase)
                                   + 0.15 * sin(t * (active ? 9.3 : 0) + phase * 1.7)
                    let h = max(2, size.height * CGFloat(0.12 + amp * wave))
                    let x = CGFloat(i) * (bw + gap)
                    let rect = CGRect(x: x, y: size.height - h, width: bw, height: h)
                    let shade = GraphicsContext.Shading.linearGradient(
                        Gradient(colors: [color.opacity(0.30), color, .white.opacity(active ? 0.55 : 0)]),
                        startPoint: CGPoint(x: 0, y: size.height),
                        endPoint: CGPoint(x: 0, y: size.height - h))
                    let bar = Path(roundedRect: rect, cornerRadius: bw / 2)
                    ctx.fill(bar, with: shade)
                }
            }
        }
    }
}

// MARK: - Activity sparkline

/// A smooth line + gradient fill of an agent's recent event rate. Real data,
/// not decoration — you can see it spike on a flurry of tool calls and taper as
/// it wraps up.
struct Sparkline: View {
    var samples: [Double]
    var color: Color

    var body: some View {
        Canvas { ctx, size in
            guard samples.count > 1 else { return }
            let stepX = size.width / CGFloat(samples.count - 1)
            func point(_ i: Int) -> CGPoint {
                CGPoint(x: CGFloat(i) * stepX,
                        y: size.height - CGFloat(samples[i]) * (size.height - 2) - 1)
            }
            var line = Path()
            line.move(to: point(0))
            for i in 1..<samples.count {
                let p = point(i), prev = point(i - 1)
                let mid = CGPoint(x: (p.x + prev.x) / 2, y: (p.y + prev.y) / 2)
                line.addQuadCurve(to: mid, control: prev)
            }
            line.addLine(to: point(samples.count - 1))

            var fill = line
            fill.addLine(to: CGPoint(x: size.width, y: size.height))
            fill.addLine(to: CGPoint(x: 0, y: size.height))
            fill.closeSubpath()
            ctx.fill(fill, with: .linearGradient(
                Gradient(colors: [color.opacity(0.34), color.opacity(0.015)]),
                startPoint: .zero, endPoint: CGPoint(x: 0, y: size.height)))
            // A soft glow under the trace makes it read as live energy, not a chart.
            ctx.addFilter(.shadow(color: color.opacity(0.55), radius: 2))
            ctx.stroke(line, with: .linearGradient(
                Gradient(colors: [color.opacity(0.7), color]),
                startPoint: .zero, endPoint: CGPoint(x: size.width, y: 0)),
                style: StrokeStyle(lineWidth: 1.6, lineCap: .round, lineJoin: .round))
        }
    }
}

// MARK: - Status ring

/// A circular progress ring with a rotating gradient sweep while live, a soft
/// glow, and the status glyph at its heart. Replaces the humble status dot.
struct StatusRing: View {
    var progress: Double?
    var color: Color
    var active: Bool
    var glyph: String
    var size: CGFloat = 30
    /// Extra gate (e.g. popover visibility). The gradient sweep only spins while
    /// the agent is `active` *and* visible; otherwise the TimelineView is paused
    /// so the ring stops redrawing 30×/sec. Data-driven changes (progress, glyph)
    /// still re-render because SwiftUI re-evaluates the body when they change.
    var animate: Bool = true

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 24.0, paused: !(active && animate))) { timeline in
            let angle = active ? timeline.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 2) / 2 * 360 : 0
            ZStack {
                // Faint tinted disc behind the glyph gives the ring some depth.
                Circle().fill(
                    RadialGradient(colors: [color.opacity(active ? 0.22 : 0.10), .clear],
                                   center: .center, startRadius: 0, endRadius: size * 0.55))
                Circle().stroke(color.opacity(0.16), lineWidth: 3)
                if active {
                    Circle()
                        .trim(from: 0, to: 0.85)
                        .stroke(AngularGradient(colors: [color.opacity(0), color.opacity(0.6), color, .white],
                                                center: .center),
                                style: StrokeStyle(lineWidth: 3, lineCap: .round))
                        .rotationEffect(.degrees(angle))
                }
                if let p = progress {
                    Circle()
                        .trim(from: 0, to: max(0.02, p))
                        .stroke(LinearGradient(colors: Color.gradientPair(color),
                                               startPoint: .top, endPoint: .bottom),
                                style: StrokeStyle(lineWidth: 3, lineCap: .round))
                        .rotationEffect(.degrees(-90))
                }
                Image(systemName: glyph)
                    .font(.system(size: size * 0.36, weight: .bold))
                    .foregroundStyle(color)
            }
            .frame(width: size, height: size)
            .shadow(color: active ? color.opacity(0.55) : .clear, radius: active ? 7 : 0)
        }
    }
}

// MARK: - Celebration burst

/// A confetti burst fired when an agent finishes. Driven entirely by elapsed
/// time since the trigger so it's self-contained and replayable.
struct Celebration: View {
    var trigger: Date?
    private let duration: TimeInterval = 1.5
    private let count = 36

    var body: some View {
        GeometryReader { geo in
            if let trigger {
                TimelineView(.animation) { timeline in
                    let elapsed = timeline.date.timeIntervalSince(trigger)
                    Canvas { ctx, size in
                        guard elapsed >= 0, elapsed <= duration else { return }
                        let progress = elapsed / duration
                        for i in 0..<count {
                            let seed = Double((i * 2654435761) % 1000) / 1000
                            let seed2 = Double((i * 40503) % 1000) / 1000
                            let angle = seed * .pi * 2
                            let dist = (40 + seed2 * 120) * progress
                            let x = size.width / 2 + cos(angle) * dist
                            let y = size.height * 0.35 + sin(angle) * dist + progress * progress * 160
                            let s = 3.0 + seed2 * 4
                            let hue = Color(hue: seed, saturation: 0.85, brightness: 1)
                            var c = ctx
                            c.opacity = 1 - progress
                            c.translateBy(x: x, y: y)
                            c.rotate(by: .radians(elapsed * 8 + seed * 6))
                            c.fill(Path(CGRect(x: -s/2, y: -s/2, width: s, height: s * 0.5)),
                                   with: .color(hue))
                        }
                    }
                    .allowsHitTesting(false)
                }
            }
        }
    }
}

// MARK: - Rolling number

/// A number that smoothly tweens between values when it changes — small touch,
/// big "this thing is alive" payoff on the dashboard counters.
struct RollingNumber: View, Animatable {
    var value: Double
    var size: CGFloat = 13
    var weight: Font.Weight = .bold

    var animatableData: Double {
        get { value }
        set { value = newValue }
    }

    var body: some View {
        Text("\(Int(value.rounded()))")
            .font(.system(size: size, weight: weight, design: .rounded))
            .monospacedDigit()
    }
}
