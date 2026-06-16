import SwiftUI

// MARK: - Aurora background

/// A slow, living gradient that drifts behind the whole window. Its hue is
/// tinted by the fleet's dominant state, so the app subtly "feels" busy when
/// agents are working and cools off when they're done.
struct AuroraBackground: View {
    var tint: Color
    var energy: Double   // 0…1, scales motion + brightness

    var body: some View {
        // Drifts slowly, so 20fps is indistinguishable from 60 and far cheaper.
        TimelineView(.animation(minimumInterval: 1.0 / 20.0)) { timeline in
            let t = timeline.date.timeIntervalSinceReferenceDate
            Canvas { ctx, size in
                ctx.fill(Path(CGRect(origin: .zero, size: size)),
                         with: .color(Color.black.opacity(0.001)))   // keep canvas opaque-ish
                let blobs = 3
                for i in 0..<blobs {
                    let phase = Double(i) * 2.1
                    let speed = 0.18 + Double(i) * 0.05
                    let cx = size.width  * (0.5 + 0.42 * sin(t * speed + phase))
                    let cy = size.height * (0.5 + 0.42 * cos(t * speed * 0.8 + phase * 1.3))
                    let r = size.width * (0.55 + 0.12 * sin(t * 0.3 + phase))
                    let hue = i == 0 ? tint : (i == 1 ? tint.opacity(0.7) : Color.purple)
                    let rect = CGRect(x: cx - r, y: cy - r, width: r * 2, height: r * 2)
                    ctx.fill(
                        Circle().path(in: rect),
                        with: .radialGradient(
                            Gradient(colors: [hue.opacity(0.22 + 0.18 * energy), .clear]),
                            center: CGPoint(x: cx, y: cy),
                            startRadius: 0, endRadius: r))
                }
            }
            .blur(radius: 8)
        }
        .drawingGroup()
        .opacity(0.9)
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

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30.0)) { timeline in
            let t = timeline.date.timeIntervalSinceReferenceDate
            Canvas { ctx, size in
                let gap: CGFloat = 2
                let bw = (size.width - gap * CGFloat(bars - 1)) / CGFloat(bars)
                let amp = active ? (0.25 + 0.75 * intensity) : 0.06
                for i in 0..<bars {
                    let phase = Double(i) * 0.55
                    let wave = 0.5 + 0.5 * sin(t * (active ? 6.0 : 0) + phase)
                    let h = max(2, size.height * CGFloat(0.12 + amp * wave))
                    let x = CGFloat(i) * (bw + gap)
                    let rect = CGRect(x: x, y: size.height - h, width: bw, height: h)
                    let shade = GraphicsContext.Shading.linearGradient(
                        Gradient(colors: [color.opacity(0.35), color]),
                        startPoint: CGPoint(x: 0, y: size.height),
                        endPoint: CGPoint(x: 0, y: 0))
                    ctx.fill(Path(roundedRect: rect, cornerRadius: bw / 2), with: shade)
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
                Gradient(colors: [color.opacity(0.30), color.opacity(0.02)]),
                startPoint: .zero, endPoint: CGPoint(x: 0, y: size.height)))
            ctx.stroke(line, with: .color(color), style: StrokeStyle(lineWidth: 1.5, lineJoin: .round))
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

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30.0)) { timeline in
            let angle = active ? timeline.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 2) / 2 * 360 : 0
            ZStack {
                Circle().stroke(color.opacity(0.18), lineWidth: 3)
                if active {
                    Circle()
                        .trim(from: 0, to: 0.85)
                        .stroke(AngularGradient(colors: [color.opacity(0), color],
                                                center: .center),
                                style: StrokeStyle(lineWidth: 3, lineCap: .round))
                        .rotationEffect(.degrees(angle))
                }
                if let p = progress {
                    Circle()
                        .trim(from: 0, to: max(0.02, p))
                        .stroke(color, style: StrokeStyle(lineWidth: 3, lineCap: .round))
                        .rotationEffect(.degrees(-90))
                }
                Image(systemName: glyph)
                    .font(.system(size: size * 0.36, weight: .bold))
                    .foregroundStyle(color)
            }
            .frame(width: size, height: size)
            .shadow(color: active ? color.opacity(0.6) : .clear, radius: active ? 6 : 0)
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
