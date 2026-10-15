import CoreImage
import SwiftUI
import UIKit

@MainActor
final class AgentReasoningBackdropSource {
    weak var scrollView: UIScrollView?
    weak var defocusView: AgentReasoningDefocusView?
    private(set) var isActive = false
    private(set) var captureVersion: UInt = 0

    func activate() {
        captureVersion &+= 1
        isActive = true
    }

    func deactivate() {
        isActive = false
        captureVersion &+= 1
        defocusView?.stop()
    }
}

struct AgentReasoningBackdropProbe: UIViewRepresentable {
    let source: AgentReasoningBackdropSource

    func makeUIView(context: Context) -> ProbeView {
        ProbeView(source: source)
    }

    func updateUIView(_ view: ProbeView, context: Context) {
        view.source = source
        view.resolveScrollView()
    }

    final class ProbeView: UIView {
        var source: AgentReasoningBackdropSource

        init(source: AgentReasoningBackdropSource) {
            self.source = source
            super.init(frame: .zero)
            backgroundColor = .clear
            isUserInteractionEnabled = false
            accessibilityElementsHidden = true
        }

        required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

        override func didMoveToSuperview() {
            super.didMoveToSuperview()
            resolveScrollView()
        }

        override func didMoveToWindow() {
            super.didMoveToWindow()
            resolveScrollView()
        }

        override func layoutSubviews() {
            super.layoutSubviews()
            resolveScrollView()
        }

        func resolveScrollView() {
            var ancestor = superview
            while let view = ancestor {
                if let scroll = view as? UIScrollView {
                    source.scrollView = scroll
                    return
                }
                ancestor = view.superview
            }
        }
    }
}

struct AgentReasoningDefocus: UIViewRepresentable {
    let source: AgentReasoningBackdropSource
    let composerBottomGap: CGFloat
    let composerHeight: CGFloat
    let horizontalInset: CGFloat
    // The chat already uses this opaque color. It backs transparent text pixels
    // during capture; the effect adds no material tint or colored veil.
    let backgroundColor: UIColor
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    func makeUIView(context: Context) -> AgentReasoningDefocusView {
        AgentReasoningDefocusView()
    }

    func updateUIView(_ view: AgentReasoningDefocusView, context: Context) {
        view.configure(source: source, composerBottomGap: composerBottomGap,
                       composerHeight: composerHeight, horizontalInset: horizontalInset,
                       backgroundColor: backgroundColor, enabled: !reduceTransparency)
    }

    static func dismantleUIView(_ view: AgentReasoningDefocusView, coordinator: ()) {
        view.stop()
    }
}

@MainActor
final class AgentReasoningDefocusView: UIView {
    private let imageView = UIImageView()
    private let context = CIContext(options: [.cacheIntermediates: false])
    private let defocusRenderer = AgentReasoningDefocusRenderer()
    private var source: AgentReasoningBackdropSource?
    private var composerBottomGap: CGFloat = 0
    private var composerHeight: CGFloat = 0
    private var horizontalInset: CGFloat = 0
    private var chatBackground = UIColor.white
    private var enabled = false
    private var timer: Timer?
    private var rendering = false

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .clear
        isOpaque = false
        isUserInteractionEnabled = false
        accessibilityElementsHidden = true
        imageView.isUserInteractionEnabled = false
        imageView.accessibilityElementsHidden = true
        imageView.contentMode = .scaleToFill
        // Fully replace the live glyphs so sharp text cannot show through.
        imageView.alpha = 1
        addSubview(imageView)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func configure(source: AgentReasoningBackdropSource, composerBottomGap: CGFloat,
                   composerHeight: CGFloat, horizontalInset: CGFloat,
                   backgroundColor: UIColor, enabled: Bool) {
        self.source = source
        source.defocusView = self
        self.composerBottomGap = composerBottomGap
        self.composerHeight = composerHeight
        self.horizontalInset = horizontalInset
        chatBackground = backgroundColor
        self.enabled = enabled
        updateTimer()
        setNeedsLayout()
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        updateTimer()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        refresh()
    }

    func stop() {
        timer?.invalidate()
        timer = nil
        imageView.image = nil
    }

    private func updateTimer() {
        guard enabled, source?.isActive == true, window != nil else {
            stop()
            return
        }
        guard timer == nil else { return }
        let timer = Timer(timeInterval: 1.0 / 15.0, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.refresh() }
        }
        self.timer = timer
        RunLoop.main.add(timer, forMode: .common)
        refresh()
    }

    private func refresh() {
        guard !rendering else { return }
        guard enabled, let source, source.isActive,
              bounds.width > 0, bounds.height > 0,
              let scroll = source.scrollView, scroll.window === window, window != nil else {
            imageView.image = nil
            return
        }
        let captureVersion = source.captureVersion
        rendering = true
        defer { rendering = false }

        let composerBand = CGRect(x: horizontalInset,
                                  y: bounds.height - composerBottomGap - composerHeight,
                                  width: bounds.width - 2 * horizontalInset, height: composerHeight)
        guard composerBand.width > 0, composerBand.height > 0 else { imageView.image = nil; return }
        // Keep the upper feather aligned with the composer, but carry the lower
        // edge beyond the viewport so defocus continues to the keyboard edge.
        let feather = min(26, composerBand.height / 4)
        let envelope = CGRect(x: composerBand.minX, y: composerBand.minY + feather,
                              width: composerBand.width,
                              height: composerBand.height + composerBottomGap)
        // Soften glyph edges without spreading the ink into a gray cloud.
        let radius: CGFloat = 2.5
        let capture = envelope.insetBy(dx: -feather - radius * 3,
                                       dy: -feather - radius * 3).intersection(bounds)
        guard !capture.isNull, !capture.isEmpty else { imageView.image = nil; return }
        let scale = min(window?.screen.scale ?? 2, 2)
        let format = UIGraphicsImageRendererFormat()
        format.scale = scale
        format.opaque = true
        let renderer = UIGraphicsImageRenderer(size: capture.size, format: format)
        let sourceFrame = scroll.convert(scroll.bounds, to: self)
            .offsetBy(dx: -capture.minX, dy: -capture.minY)
        var captured = false
        let snapshot = renderer.image { output in
            chatBackground.setFill()
            output.fill(CGRect(origin: .zero, size: capture.size))
            // Capture only this scroll subtree. Composer, slider and keyboard are
            // siblings; none is hidden, copied or asked to change first responder.
            captured = scroll.drawHierarchy(in: sourceFrame, afterScreenUpdates: false)
        }
        guard captured, let result = defocusRenderer.render(
            snapshot: snapshot, envelope: envelope.offsetBy(dx: -capture.minX, dy: -capture.minY),
            radius: radius, feather: feather, context: context) else {
            imageView.image = nil
            return
        }
        // Ignore any readback invalidated by a close/reopen during rendering.
        guard source.isActive, source.captureVersion == captureVersion else {
            imageView.image = nil
            return
        }
        imageView.frame = capture
        imageView.image = result
    }
}

@MainActor
final class AgentReasoningDefocusRenderer {
    private struct Masks {
        let width: Int
        let height: Int
        let scale: CGFloat
        let envelope: CGRect
        let feather: CGFloat
        let blur: CGImage
        let alpha: CGImage
    }
    private var cachedMasks: Masks?
    // A single rasterized viewport has no per-message clipping edges. Variable
    // radius reaches zero before alpha fades out, keeping the outer edge smooth.
    func render(snapshot: UIImage, envelope: CGRect, radius: CGFloat,
                       feather: CGFloat, context: CIContext) -> UIImage? {
        guard let cgImage = snapshot.cgImage else { return nil }
        let scale = snapshot.scale
        let width = cgImage.width
        let height = cgImage.height
        guard width > 0, height > 0 else { return nil }
        guard let masks = masks(width: width, height: height, scale: scale,
                                envelope: envelope, feather: feather) else { return nil }
        let input = CIImage(cgImage: cgImage)
        let blurred = input.clampedToExtent().applyingFilter("CIMaskedVariableBlur", parameters: [
            "inputMask": CIImage(cgImage: masks.blur),
            "inputRadius": radius * scale
        ]).cropped(to: input.extent)
        let output = blurred.applyingFilter("CIBlendWithMask", parameters: [
            kCIInputBackgroundImageKey: CIImage(color: .clear).cropped(to: input.extent),
            kCIInputMaskImageKey: CIImage(cgImage: masks.alpha)
        ])
        guard let result = context.createCGImage(output, from: input.extent) else { return nil }
        return UIImage(cgImage: result, scale: scale, orientation: .up)
    }

    private func masks(width: Int, height: Int, scale: CGFloat,
                       envelope: CGRect, feather: CGFloat) -> Masks? {
        if let masks = cachedMasks, masks.width == width, masks.height == height,
           masks.scale == scale, masks.envelope == envelope, masks.feather == feather {
            return masks
        }
        var blurMask = [UInt8](repeating: 0, count: width * height)
        var alphaMask = [UInt8](repeating: 0, count: width * height)
        let corner = min(envelope.height / 2, 40)
        let half = CGSize(width: envelope.width / 2 - corner,
                          height: envelope.height / 2 - corner)
        for y in 0..<height {
            for x in 0..<width {
                let point = CGPoint(x: (CGFloat(x) + 0.5) / scale,
                                    y: (CGFloat(y) + 0.5) / scale)
                let qx = abs(point.x - envelope.midX) - half.width
                let qy = abs(point.y - envelope.midY) - half.height
                let distance = hypot(max(qx, 0), max(qy, 0)) + min(max(qx, qy), 0) - corner
                let amount = 1 - smoothstep(max(0, distance) / feather)
                let index = y * width + x
                blurMask[index] = UInt8((amount * 255).rounded())
                // Keep full replacement wherever the blur is appreciable. Only
                // the final 20% of its feather crossfades back to the live pixels.
                alphaMask[index] = UInt8(((1 - smoothstep(
                    (max(0, distance) / feather - 0.8) / 0.2)) * 255).rounded())
            }
        }
        guard let blurCG = maskImage(bytes: blurMask, width: width, height: height),
              let alphaCG = maskImage(bytes: alphaMask, width: width, height: height) else { return nil }
        let masks = Masks(width: width, height: height, scale: scale, envelope: envelope,
                          feather: feather, blur: blurCG, alpha: alphaCG)
        cachedMasks = masks
        return masks
    }

    private func smoothstep(_ value: CGFloat) -> CGFloat {
        let t = min(max(value, 0), 1)
        return t * t * (3 - 2 * t)
    }

    private func maskImage(bytes: [UInt8], width: Int, height: Int) -> CGImage? {
        guard let provider = CGDataProvider(data: Data(bytes) as CFData) else { return nil }
        return CGImage(width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 8,
                       bytesPerRow: width, space: CGColorSpaceCreateDeviceGray(),
                       bitmapInfo: [], provider: provider, decode: nil,
                       shouldInterpolate: true, intent: .defaultIntent)
    }
}
