import SwiftUI

/// One source of truth for an agent's accent colour, shared by the dot, ring,
/// equalizer, sparkline and card glow so the whole card reads as one organism.
extension AgentRun {
    var accent: Color {
        switch status {
        case .active: return AgentRun.workingTint                                   // emerald: burning
        case .idle:   return wasActive ? AgentRun.waitingTint                       // amber: was busy
                                       : Color(red: 1.0, green: 0.56, blue: 0.30)   // orange: just sitting
        case .done:   return AgentRun.doneTint                                      // periwinkle: finished
        }
    }

    /// The four-state palette, in one place so the brand bar, dashboard chips,
    /// aurora tint and per-card accents all sing from the same harmonised hues.
    static let workingTint = Color(red: 0.24, green: 0.94, blue: 0.62)   // emerald
    static let waitingTint = Color(red: 1.0,  green: 0.78, blue: 0.26)   // warm amber
    static let doneTint    = Color(red: 0.46, green: 0.60, blue: 1.0)    // periwinkle

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
