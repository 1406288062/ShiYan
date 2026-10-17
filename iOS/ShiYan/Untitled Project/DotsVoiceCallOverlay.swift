import SwiftUI

/// Match the existing navigation row and reserve its leading/trailing buttons.
enum DotsVoiceCallLayout {
    static let height = ShiyanPreviewLayout.controlDiameter
    static func width(in viewport: CGFloat) -> CGFloat {
        let side = 16 + ShiyanPreviewLayout.controlDiameter + 8
        return min(360, max(0, viewport - side * 2))
    }
}

/// The app owns this call surface, so changing conversations keeps it visible.
struct DotsVoiceCallOverlay: View {
    let isDotsVisible: Bool
    var syncPresentation = true
    var topInset: CGFloat = 0
    var showsCallCard = true
    @ObservedObject private var voice = DotsVoiceSession.shared
    @ObservedObject private var presentation = DotsVoicePresentation.shared
    @Environment(\.accessibilityReduceMotion) private var reducedMotion

    var body: some View {
        GeometryReader { geometry in
            if voice.active && showsCallCard {
                DotsVoiceCallCard()
                    .frame(width: DotsVoiceCallLayout.width(in: geometry.size.width))
                    .position(x: geometry.size.width / 2,
                              y: topInset + 3 + DotsVoiceCallLayout.height / 2)
            }
        }
        .allowsHitTesting(voice.active && showsCallCard)
        .onChange(of: voice.active, initial: true) { _, _ in syncMaterial() }
        .onChange(of: voice.phase) { _, _ in syncMaterial() }
        .onChange(of: voice.level) { _, _ in syncMaterial() }
        .onChange(of: isDotsVisible, initial: true) { _, value in if syncPresentation { presentation.setVisible(value) } }
        .onChange(of: reducedMotion, initial: true) { _, value in if syncPresentation { presentation.setReducedMotion(value) } }
    }

    private func syncMaterial() {
        guard syncPresentation else { return }
        presentation.setState(active: voice.active, phase: voice.phase.rawValue, level: voice.level)
    }
}

struct DotsVoiceCallCard: View {
    @ObservedObject private var voice = DotsVoiceSession.shared
    @ObservedObject private var store = DotsStore.shared

    var body: some View {
        HStack(spacing: 2) {
            Button { voice.interrupt() } label: {
                TimelineView(.periodic(from: .now, by: 1)) { tick in
                    ViewThatFits(in: .horizontal) {
                        identity(at: tick.date, showsPet: true, showsName: true)
                        identity(at: tick.date, showsPet: true, showsName: false)
                        identity(at: tick.date, showsPet: false, showsName: false)
                    }
                    .frame(maxWidth: .infinity, alignment: .center)
                    .frame(height: ShiyanPreviewLayout.controlDiameter)
                    .contentShape(Rectangle())
                }
            }
            .accessibilityIdentifier("dots-voice-call-identity")
            .accessibilityLabel("与 \(store.displayName) 的语音通话")
            .accessibilityValue(voice.phase.title)
            .accessibilityHint("轻点打断播报，暂停或继续聆听")

            Button { voice.toggleMute() } label: {
                Image(systemName: voice.muted ? "mic.slash" : "mic")
                    .font(.system(size: 18, weight: .medium))
                    .foregroundStyle(voice.muted ? Color.red : Color.primary)
                    .frame(width: ShiyanPreviewLayout.controlDiameter,
                           height: ShiyanPreviewLayout.controlDiameter)
                    .contentShape(Circle())
            }
            .accessibilityLabel(voice.muted ? "取消麦克风静音" : "静音麦克风")
            .accessibilityValue(voice.muted ? "已静音" : "已开启")
            .accessibilityIdentifier("dots-voice-mute")

            Button { voice.end() } label: {
                Image(systemName: "phone.down.fill")
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(width: 32, height: 32)
                    .background(Color.red, in: Circle())
                    .frame(width: ShiyanPreviewLayout.controlDiameter,
                           height: ShiyanPreviewLayout.controlDiameter)
                    .contentShape(Circle())
            }
            .accessibilityLabel("挂断语音通话")
            .accessibilityIdentifier("dots-voice-end")
        }
        .buttonStyle(.plain)
        .padding(.horizontal, 4)
        .shiyanGlass(in: Capsule(), interactive: true)
        .shadow(color: .black.opacity(0.08), radius: 12, y: 4)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("dots-voice-call-card")
        .accessibilityAction(named: "打断播报，暂停或继续聆听") { voice.interrupt() }
    }

    private func identity(at date: Date, showsPet: Bool, showsName: Bool) -> some View {
        HStack(spacing: 4) {
            if showsPet { DotsLivePet().frame(width: 24, height: 28).allowsHitTesting(false) }
            if showsName {
                Text(store.displayName).font(.caption.weight(.semibold)).lineLimit(1)
            }
            Text(voice.elapsedText(at: date))
                .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
        }
        .fixedSize(horizontal: true, vertical: false)
    }

}
