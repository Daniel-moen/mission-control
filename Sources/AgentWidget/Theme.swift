import SwiftUI

/// One source of truth for an agent's accent colour, shared by the dot, ring,
/// equalizer, sparkline and card glow so the whole card reads as one organism.
extension AgentRun {
    var accent: Color {
        switch status {
        case .active: return Color(red: 0.20, green: 0.92, blue: 0.55)   // electric green
        case .idle:   return wasActive ? Color(red: 1.0, green: 0.80, blue: 0.18)   // amber: was busy
                                       : Color(red: 1.0, green: 0.55, blue: 0.25)   // orange: just sitting
        case .done:   return Color(red: 0.40, green: 0.55, blue: 0.95)   // calm blue: finished
        }
    }

    /// Whether this card should run its live, energy-burning animations.
    var isLive: Bool { status == .active }
}

extension AgentStatus {
    var glyph: String {
        switch self {
        case .active: return "bolt.fill"
        case .idle:   return "pause.circle.fill"
        case .done:   return "checkmark.circle.fill"
        }
    }
}

extension Color {
    /// Sample two colours along a hue for gradient strokes.
    static func gradientPair(_ base: Color) -> [Color] { [base.opacity(0.65), base] }
}
