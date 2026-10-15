import SwiftUI
import UIKit

 
 
struct AgentReasoningBackdrop: UIViewRepresentable {
    static let haloExtent: CGFloat = 58
    let controlSize: CGSize
    let darkMode: Bool

    func makeUIView(context: Context) -> AgentReasoningBackdropSurface {
        AgentReasoningBackdropSurface()
    }

    func updateUIView(_ view: AgentReasoningBackdropSurface, context: Context) {
        view.configure(controlSize: controlSize, darkMode: darkMode)
    }
}

 
 
enum AgentReasoningHaloMask {
     
     
    static let maximumCoverage: CGFloat = 0.88
    static let layerCount = 32
    static func falloff(distance: CGFloat, extent: CGFloat) -> CGFloat {
        let t = min(max(distance / max(extent, 1), 0), 1)
         
         
         
        let remaining = 1 - t * t
        return remaining * remaining
    }
}

final class AgentReasoningBackdropSurface: UIView {
    private let effectView = UIVisualEffectView(effect: nil)
    private let coverage = UIView()
    private var contours: [CAShapeLayer] = []
    private var controlSize: CGSize = .zero
    private var darkMode: Bool?
    private var renderedBounds: CGRect?
    private var renderedEnvelope: CGRect?

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .clear
        isUserInteractionEnabled = false
        isAccessibilityElement = false
        clipsToBounds = true
        effectView.backgroundColor = .clear
        effectView.isUserInteractionEnabled = false
        effectView.isAccessibilityElement = false
        effectView.isHidden = true
        coverage.backgroundColor = .clear
        coverage.isUserInteractionEnabled = false
        coverage.isAccessibilityElement = false
         
         
        effectView.mask = coverage
        addSubview(effectView)
        var previous: CGFloat = 0
        for index in 0..<AgentReasoningHaloMask.layerCount {
            let expansion = AgentReasoningBackdrop.haloExtent *
                CGFloat(AgentReasoningHaloMask.layerCount - 1 - index) /
                CGFloat(AgentReasoningHaloMask.layerCount - 1)
            let target = AgentReasoningHaloMask.maximumCoverage *
                AgentReasoningHaloMask.falloff(distance: expansion,
                                              extent: AgentReasoningBackdrop.haloExtent)
             
             
            let alpha = previous < 1 ? (target - previous) / (1 - previous) : 0
            let contour = CAShapeLayer()
            contour.fillColor = UIColor.white.withAlphaComponent(max(0, min(alpha, 1))).cgColor
            contour.allowsEdgeAntialiasing = true
            coverage.layer.addSublayer(contour)
            contours.append(contour)
            previous = target
        }
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func configure(controlSize: CGSize, darkMode: Bool) {
        if self.darkMode != darkMode {
            self.darkMode = darkMode
             
             
            effectView.overrideUserInterfaceStyle = darkMode ? .dark : .light
            effectView.effect = UIBlurEffect(style: .systemThinMaterial)
            renderedBounds = nil
            renderedEnvelope = nil
            setNeedsLayout()
        }
        if self.controlSize != controlSize {
            self.controlSize = controlSize
            setNeedsLayout()
        }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        guard bounds.width > 0, bounds.height > 0,
              controlSize.width > 0, controlSize.height > 0 else {
            effectView.isHidden = true
            renderedBounds = nil
            renderedEnvelope = nil
            return
        }
        let halo = AgentReasoningBackdrop.haloExtent
        let envelope = AgentReasoningControl.backdropEnvelope(in:
            CGRect(origin: CGPoint(x: halo, y: halo), size: controlSize))
        guard renderedBounds != bounds || renderedEnvelope != envelope else { return }
        renderedBounds = bounds
        renderedEnvelope = envelope
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        effectView.frame = bounds
        coverage.frame = effectView.bounds
        let radius = min(envelope.width, envelope.height) / 2
        for (index, contour) in contours.enumerated() {
            let expansion = halo * CGFloat(contours.count - 1 - index) /
                CGFloat(contours.count - 1)
            let shape = envelope.insetBy(dx: -expansion, dy: -expansion)
            contour.frame = coverage.bounds
            contour.path = UIBezierPath(roundedRect: shape,
                cornerRadius: radius + expansion).cgPath
        }
         
         
        effectView.mask = nil
        effectView.mask = coverage
        effectView.isHidden = false
        CATransaction.commit()
    }
}
