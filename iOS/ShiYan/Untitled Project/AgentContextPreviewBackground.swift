import SwiftUI
import UIKit

 
 
 
struct AgentContextPreviewBackground: UIViewRepresentable {
    func makeUIView(context: Context) -> ClearPreviewView { ClearPreviewView() }
    func updateUIView(_ view: ClearPreviewView, context: Context) { view.clearHostingBackground() }

    final class ClearPreviewView: UIView {
        override init(frame: CGRect) {
            super.init(frame: frame)
            backgroundColor = .clear
            isUserInteractionEnabled = false
            isAccessibilityElement = false
        }
        required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
        override func didMoveToWindow() {
            super.didMoveToWindow()
            clearHostingBackground()
        }
        override func layoutSubviews() {
            super.layoutSubviews()
            clearHostingBackground()
        }
        func clearHostingBackground() {
            guard window != nil else { return }
            var responder: UIResponder? = self
            while let current = responder {
                if let controller = current as? UIViewController {
                    controller.view.backgroundColor = .clear
                    controller.view.isOpaque = false
                    return
                }
                responder = current.next
            }
        }
    }
}
