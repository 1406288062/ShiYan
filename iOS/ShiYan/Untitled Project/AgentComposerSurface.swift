import SwiftUI

 
private struct AgentComposerSurface: ViewModifier {
    let cornerRadius: CGFloat
    let glassVisible: Bool
    func body(content: Content) -> some View {
        let outline = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        content
            .background {
                // Keep one glass background alive across the slider/composer
                // switch; never rebuild its effect around the native editor.
                outline.fill(.clear)
                    .glassEffect(.regular.tint(.white.opacity(0.08)).interactive(false),
                                 in: outline)
                    .opacity(glassVisible ? 1 : 0)
                    .transaction { transaction in
                        transaction.animation = nil
                        transaction.disablesAnimations = true
                    }
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
            }
            .clipShape(outline)
    }
}

extension View {
    func agentComposerSurface(cornerRadius: CGFloat, glassVisible: Bool = true) -> some View {
        modifier(AgentComposerSurface(cornerRadius: cornerRadius, glassVisible: glassVisible))
    }
}
