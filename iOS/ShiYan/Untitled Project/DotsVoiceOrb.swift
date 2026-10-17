import SwiftUI
import Combine
import QuartzCore

/// Owns the visible form only. Fusing, dragging and leaving Dots never end a call.
@MainActor
final class DotsVoicePresentation: ObservableObject {
    static let shared = DotsVoicePresentation()
    @Published private(set) var active = false
    @Published private(set) var phase = "idle"
    @Published private(set) var level = 0.0
    @Published private(set) var visible = true
    @Published private(set) var material = DotsVoiceMaterialState()
    private var reducedMotion = false
    private var displayLink: CADisplayLink?
    private var lastFrameTime: CFTimeInterval?
    private(set) var measuredTravel: CGFloat?

    var progress: Double { material.progress }
    var form: DotsVoiceMaterialState.Form { material.form }
    var immersive: Bool { active && progress < 0.82 }
    var animating: Bool { material.isTransitioning }
    var phaseLabel: String {
        switch phase {
        case "listening": return "我在听"
        case "waiting", "thinking", "sending": return "正在思考"
        case "starting": return "正在准备语音"
        case "speaking": return "正在回应"
        case "muted": return "麦克风已静音"
        case "paused": return "已暂停聆听"
        default: return "语音交流中"
        }
    }

    func setState(active: Bool, phase: String, level: Double = 0) {
        let changed = self.active != active
        self.active = active
        self.phase = phase
        self.level = min(1, max(0, level))
        if changed {
            cancelTransition()
            material.reset()
        }
    }

    func setVisible(_ visible: Bool) {
        guard self.visible != visible else { return }
        self.visible = visible
        cancelTransition()
        if !visible && form == .dragging {
            material.dragEnded(travel: 300, now: ProcessInfo.processInfo.systemUptime,
                               cancelled: true, reducedMotion: reducedMotion)
        }
        if visible { runTransition() }
    }

    func setReducedMotion(_ value: Bool) { reducedMotion = value }
    func setTravel(_ value: CGFloat) { measuredTravel = max(175, value) }
    func collapse() {
        guard active && visible else { return }
        material.collapse(reducedMotion: reducedMotion)
        runTransition()
    }
    func dragChanged(translation: CGSize, travel: CGFloat) {
        guard active && visible else { return }
        material.dragChanged(x: Double(translation.width), upward: Double(-translation.height),
                             travel: Double(travel), now: ProcessInfo.processInfo.systemUptime)
    }
    func dragEnded(travel: CGFloat, cancelled: Bool = false) {
        material.dragEnded(travel: Double(travel), now: ProcessInfo.processInfo.systemUptime,
                           cancelled: cancelled, reducedMotion: reducedMotion)
        runTransition()
    }
    func expandAccessibly() {
        guard active && visible else { return }
        material.expandAccessibly(reducedMotion: reducedMotion)
        runTransition()
    }

    private func runTransition() {
        guard active && visible && material.isTransitioning && displayLink == nil else { return }
        let link = CADisplayLink(target: DotsVoiceTransitionDriver(self), selector: #selector(DotsVoiceTransitionDriver.tick(_:)))
        link.preferredFrameRateRange = CAFrameRateRange(minimum: 60, maximum: 60, preferred: 60)
        lastFrameTime = nil
        displayLink = link
        link.add(to: .main, forMode: .common)
    }
    fileprivate func advanceTransition(at timestamp: CFTimeInterval) {
        guard active && visible && material.isTransitioning else { cancelTransition(); return }
        let elapsed = lastFrameTime.map { timestamp - $0 } ?? 0
        lastFrameTime = timestamp
        material.advance(seconds: elapsed)
        if !material.isTransitioning { cancelTransition() }
    }
    private func cancelTransition() {
        displayLink?.invalidate()
        displayLink = nil
        lastFrameTime = nil
    }
    deinit { displayLink?.invalidate() }
}

/// CADisplayLink retains its target, so the target must not retain presentation.
@MainActor
private final class DotsVoiceTransitionDriver: NSObject {
    weak var presentation: DotsVoicePresentation?
    init(_ presentation: DotsVoicePresentation) { self.presentation = presentation }
    @objc func tick(_ link: CADisplayLink) { presentation?.advanceTransition(at: link.timestamp) }
}

private enum DotsVoicePalette {
    static let colors = [Color(red: 78/255, green: 175/255, blue: 234/255),
                         Color(red: 94/255, green: 96/255, blue: 237/255),
                         Color(red: 171/255, green: 99/255, blue: 223/255),
                         Color(red: 243/255, green: 129/255, blue: 134/255),
                         Color(red: 88/255, green: 190/255, blue: 220/255)]
    static let horizontal = [colors[4], colors[0], colors[1], colors[2], colors[3]]
    static let glint = Color(red: 202/255, green: 235/255, blue: 255/255)
    // Match the reference caption's purple, blue and coral colour stops.
    static let caption = LinearGradient(stops: [
        .init(color: Color(red: 99/255, green: 82/255, blue: 231/255), location: 0),
        .init(color: Color(red: 67/255, green: 142/255, blue: 233/255), location: 0.52),
        .init(color: Color(red: 230/255, green: 116/255, blue: 119/255), location: 1)
    ], startPoint: .leading, endPoint: .trailing)
}

private struct DotsVoiceGeometry {
    var center: CGPoint
    var radius: CGFloat
    var sink: CGPoint
    init(size: CGSize, composerTop: CGFloat, topInset: CGFloat) {
        let sinkY = min(size.height, max(100, composerTop))
        let top = max(18, topInset)
        let available = max(120, sinkY - top - 44)
        radius = max(30, min(114, size.width * 0.23, available * 0.28))
        center = CGPoint(x: size.width / 2, y: top + available * 0.46)
        sink = CGPoint(x: size.width / 2, y: sinkY + 3)
    }
    func ball(material: DotsVoiceMaterialState, level: Double, time: Double, reducedMotion: Bool) -> DotsVoiceBall {
        let u = 1 - material.progress
        var ball = DotsVoiceBall(center: center, radius: radius, erosion: min(1, material.progress / 0.81), formation: nil)
        if material.isRising {
            if material.hasRiseOrigin {
                let formation = DotsVoiceMaterialState.clamp(material.dragDistance / material.dragTravel)
                let settle = DotsVoiceMaterialState.smooth((formation - 0.72) / 0.28)
                let origin = CGPoint(x: sink.x + material.dragOffsetX * (1 - settle),
                                     y: (sink.y - min(material.dragDistance, material.dragTravel)) * (1 - settle) + (center.y + 18) * settle - 18)
                let release = material.transition.map { DotsVoiceMaterialState.smooth($0.elapsed / $0.duration) } ?? 0
                let path = material.form == .gathering ? DotsVoiceMaterialState.smooth(release) : 0
                ball.center = CGPoint(x: origin.x + (center.x - origin.x) * path,
                                      y: origin.y + (center.y - origin.y) * path)
                if material.form == .returning {
                    let returning = DotsVoiceMaterialState.smooth((material.progress - material.releaseProgress) / max(0.001, 1 - material.releaseProgress))
                    ball.center.y = origin.y + (sink.y - origin.y) * returning
                }
            } else {
                let path = DotsVoiceMaterialState.smooth(u * 1.45)
                ball.center.y = sink.y - 18 + (center.y - sink.y + 18) * path
            }
            ball.radius = radius * pow(DotsVoiceMaterialState.smooth(u), 0.65)
            ball.erosion = pow(1 - u, 1.3)
            ball.formation = u
        }
        // Drift joins the same material path before it becomes the idle orb.
        // Changing form at progress == 0 must not add a new position offset.
        if !reducedMotion {
            ball.center.y += sin(time * 1.25) * 4 * DotsVoiceMaterialState.smooth((u - 0.68) / 0.32)
        }
        ball.radius *= 1 + level * 0.045
        return ball
    }
}

private struct DotsVoiceBall {
    var center: CGPoint
    var radius: CGFloat
    var erosion: Double
    var formation: Double?
    var edge: CGFloat { center.y + radius * (1 - 2 * erosion) }
    var edgeHalfWidth: CGFloat { radius * sqrt(max(0, 1 - pow(1 - 2 * erosion, 2))) }
}

/// Overlay in the chat viewport; composerTop is measured in that same viewport.
struct DotsVoiceScene: View {
    @ObservedObject var presentation: DotsVoicePresentation
    let composerTop: CGFloat
    var topInset: CGFloat = 0
    @Environment(\.accessibilityReduceMotion) private var reducedMotion

    var body: some View {
        GeometryReader { proxy in
            if presentation.active && presentation.visible {
                let geometry = DotsVoiceGeometry(size: proxy.size, composerTop: composerTop, topInset: topInset)
                TimelineView(.animation(minimumInterval: 1/60, paused: presentation.form == .fused || (reducedMotion && !presentation.animating))) { timeline in
                    let time = reducedMotion ? 0 : timeline.date.timeIntervalSinceReferenceDate
                    let ball = geometry.ball(material: presentation.material, level: presentation.level, time: time, reducedMotion: reducedMotion)
                    let scale = max(0.001, ball.radius / geometry.radius)
                    let captionReveal = DotsVoiceMaterialState.smooth((1 - presentation.progress - 0.68) / 0.32)
                    ZStack(alignment: .topLeading) {
                        // Keep the local WebKit page warm and paused while fused.
                        // A drag can then expose the first grains immediately, without
                        // loading a new page halfway through the reconstruction.
                        DotsVoiceOrbMaterial(level: presentation.level, reducedMotion: reducedMotion,
                                             running: presentation.form != .fused,
                                             erosion: ball.erosion, time: time, scale: scale,
                                             centerX: ball.center.x,
                                             formationBlur: ball.formation.map { min(ball.radius * 0.28, 12 * (1 - DotsVoiceMaterialState.smooth($0))) } ?? 0)
                            // Keep WebKit's viewport stable; transform the already
                            // rendered glass, mask and shadow together on the native layer.
                            .frame(width: geometry.radius * 2, height: geometry.radius * 2)
                            .scaleEffect(scale)
                            .opacity(ball.radius > 0.5 && ball.erosion < 0.999 ? 1 : 0)
                            .position(ball.center)
                            .allowsHitTesting(false)
                            .accessibilityHidden(true)
                        Canvas { context, _ in
                            drawFrontier(context: &context, ball: ball, time: time)
                            drawGrains(context: &context, geometry: geometry, ball: ball, material: presentation.material, time: time)
                            if !reducedMotion { drawGatherFinish(context: &context, ball: ball, material: presentation.material) }
                        }.allowsHitTesting(false).accessibilityHidden(true)
                        if presentation.form == .orb {
                            Circle().fill(.clear).contentShape(Circle())
                                .frame(width: geometry.radius * 2 + 24, height: geometry.radius * 2 + 24)
                                .position(geometry.center)
                                .onTapGesture { presentation.collapse() }
                                .accessibilityElement()
                                .accessibilityLabel("将语音球融入输入框，语音交流继续")
                                .accessibilityIdentifier("dots-voice-orb-hit")
                                .accessibilityAddTraits(.isButton)
                                .accessibilityAction { presentation.collapse() }
                        }
                        // Keep the caption mounted throughout the conversion, so
                        // its arrival follows the last grains rather than a form switch.
                        Text(presentation.phaseLabel)
                            .font(.subheadline.weight(.medium)).foregroundStyle(DotsVoicePalette.caption)
                            .opacity(captionReveal)
                            .blur(radius: reducedMotion ? 0 : 3 * (1 - captionReveal))
                            .position(x: geometry.center.x,
                                      y: geometry.center.y + geometry.radius + 35 + (reducedMotion ? 0 : 18 * pow(1 - captionReveal, 2)))
                            .allowsHitTesting(false)
                            .accessibilityHidden(captionReveal < 0.95)
                    }
                }
                .onAppear { presentation.setReducedMotion(reducedMotion) }
                .onAppear { presentation.setTravel(geometry.sink.y - geometry.center.y) }
                .onChange(of: geometry.sink.y - geometry.center.y) { _, value in presentation.setTravel(value) }
                .onChange(of: reducedMotion) { _, value in presentation.setReducedMotion(value) }
            }
        }
    }
}

private struct DotsVoiceOrbMaterial: View {
    let level: Double
    let reducedMotion: Bool
    let running: Bool
    let erosion: Double
    let time: Double
    let scale: Double
    let centerX: Double
    let formationBlur: Double
    var body: some View {
        GeometryReader { proxy in
            // Allow the same outer glass shadow as desktop; the measured orb and
            // native touch target still use the original diameter.
            DotsVoiceOrbWebMaterial(level: level, reducedMotion: reducedMotion, running: running,
                                    erosion: erosion, time: time, scale: scale, centerX: centerX,
                                    formationBlur: formationBlur)
                .frame(width: proxy.size.width + 160, height: proxy.size.height + 160)
                .offset(x: -80, y: -80)
        }
    }
}

private struct DotsVoiceGrain {
    let born, life, side, drift, depth, phase, size: Double
    let color: Int
    static let field: [Self] = {
        var seed: UInt32 = 15731
        func random() -> Double { seed = seed &* 1664525 &+ 1013904223; return Double(seed) / 4_294_967_296 }
        return (0..<1350).map { _ in
            Self(born: random() * 0.79, life: 0.13 + random() * 0.08,
                 side: random() * 2 - 1, drift: random() * 2 - 1, depth: random(),
                 phase: random() * .pi * 2, size: 0.35 + random() * 1.05,
                 color: min(4, Int(random() * 5)))
        }
    }()
}

private func drawFrontier(context: inout GraphicsContext, ball: DotsVoiceBall, time: Double) {
    guard ball.radius >= 0.5 && ball.erosion > 0 && ball.erosion < 1 else { return }
    let frontier = DotsVoiceMaterialState.smooth(ball.erosion / 0.16)
    for grain in DotsVoiceGrain.field.prefix(96) {
        let x = ball.center.x + grain.side * ball.edgeHalfWidth
        let y = ball.edge + sin(x * 0.31 + time * 2.7) * 2.7 + grain.depth * 10
        let radius = grain.size * 0.65
        context.fill(Path(ellipseIn: CGRect(x: x - radius, y: y - radius, width: radius * 2, height: radius * 2)),
                     with: .color(DotsVoicePalette.colors[grain.color].opacity((0.4 + grain.depth * 0.5) * frontier)))
    }
}

private func drawGatherFinish(context: inout GraphicsContext, ball: DotsVoiceBall, material: DotsVoiceMaterialState) {
    guard let finish = material.lastGrain, finish.rising, ball.radius >= 1 else { return }
    for lane in 0..<2 {
        let radius = ball.radius * (0.82 - 0.20 * finish.phase - Double(lane) * 0.055)
        let angle = Double.pi * (1.10 + 0.26 * finish.phase + Double(lane) * 0.085)
        var sheen = context
        sheen.translateBy(x: ball.center.x + cos(angle) * radius, y: ball.center.y + sin(angle) * radius)
        sheen.rotate(by: .radians(angle + .pi / 2))
        sheen.scaleBy(x: ball.radius * (0.17 - 0.08 * finish.phase), y: ball.radius * 0.045)
        let color = DotsVoicePalette.colors[lane == 0 ? 4 : 2]
        sheen.fill(Path(CGRect(x: -1, y: -1, width: 2, height: 2)),
                   with: .radialGradient(Gradient(stops: [
                    .init(color: color.opacity(finish.strength * 0.13), location: 0),
                    .init(color: color.opacity(finish.strength * 0.055), location: 0.45),
                    .init(color: color.opacity(0), location: 1)]), center: .zero, startRadius: 0, endRadius: 1))
    }
}

private func drawGrains(context: inout GraphicsContext, geometry: DotsVoiceGeometry,
                        ball: DotsVoiceBall, material: DotsVoiceMaterialState, time: Double) {
    guard material.form != .orb && material.form != .fused else { return }
    let rising = material.isRising
    let flow = rising ? 1 - material.progress : material.progress
    guard flow > 0 && flow < 1 else { return }
    context.clip(to: Path(CGRect(x: 0, y: 0, width: geometry.sink.x * 2, height: geometry.sink.y + 2)))
    for grain in DotsVoiceGrain.field {
        let flight = (flow - grain.born) / grain.life
        guard flight >= 0 && flight <= 1 else { continue }
        let ease = rising ? DotsVoiceMaterialState.smooth(flight) : flight * flight
        let spin = sin(grain.phase + flight * .pi * 4 + time * 0.35)
        let x, y: Double
        if rising {
            let targetX = ball.center.x + grain.side * ball.edgeHalfWidth * 0.82
            let absorb = DotsVoiceMaterialState.smooth(((ball.formation ?? 1) - 0.72) / 0.28)
            let targetY = ball.edge + (ball.center.y + cos(grain.phase) * ball.radius * 0.76 - ball.edge) * absorb
            let startX = geometry.sink.x + grain.side * 31
            x = startX + (targetX - startX) * ease + spin * sin(flight * .pi) * (9 + grain.depth * 13)
            y = geometry.sink.y + (targetY - geometry.sink.y) * ease
        } else {
            let erosion = DotsVoiceMaterialState.clamp(grain.born / 0.81)
            let originY = ball.center.y + geometry.radius * (1 - 2 * erosion)
            let width = geometry.radius * sqrt(max(0, 1 - pow(1 - 2 * erosion, 2)))
            let originX = geometry.center.x + grain.side * width * 0.96
            let funnel = DotsVoiceMaterialState.smooth(flight * 1.55)
            x = originX + (geometry.sink.x + grain.drift * 14 - originX) * funnel + spin * sin(flight * .pi) * (3 + grain.depth * 8)
            y = originY + (geometry.sink.y - originY) * ease
        }
        let alpha = (0.38 + grain.depth * 0.58) * min(1, flight * 14) * min(1, (1 - flight) * 17)
        let width = grain.size * (0.7 + grain.depth * 0.45)
        let height = grain.size * (1.05 + (rising ? 0 : flight * 0.7))
        context.fill(Path(ellipseIn: CGRect(x: x - width, y: y - height, width: width * 2, height: height * 2)),
                     with: .color(DotsVoicePalette.colors[grain.color].opacity(alpha)))
    }
    let contact = rising ? sin(flow * .pi) : sin(DotsVoiceMaterialState.clamp((flow - 0.1) / 0.9) * .pi)
    if contact > 0 {
        let color = DotsVoicePalette.colors[2]
        context.fill(Path(CGRect(x: geometry.sink.x - 45, y: geometry.sink.y - 45, width: 90, height: 90)),
                     with: .radialGradient(Gradient(colors: [color.opacity(contact * 0.21), color.opacity(0)]),
                                           center: geometry.sink, startRadius: 0, endRadius: 42))
    }
}

/// Place below the native editor. The canvas follows the desktop material path,
/// leaving text, selection and all input events on the existing editor layer.
struct DotsVoiceComposerMaterial: View {
    @ObservedObject var presentation: DotsVoicePresentation
    var cornerRadius: CGFloat = 26
    @Environment(\.accessibilityReduceMotion) private var reducedMotion

    var body: some View {
        if presentation.active && presentation.visible {
            let amount = presentation.material.materialAmount
            let moving = presentation.material.isTransitioning || presentation.form == .dragging
            TimelineView(.animation(minimumInterval: moving ? 1.0 / 60 : 1.0 / 20,
                                    paused: reducedMotion || presentation.form == .orb)) { timeline in
                let time = reducedMotion ? 0 : timeline.date.timeIntervalSinceReferenceDate
                let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                Canvas { context, size in
                    drawMaterial(context: &context, size: size, amount: amount, time: time)
                }
                .clipShape(shape)
                .overlay(shape.strokeBorder(LinearGradient(colors: [DotsVoicePalette.glint.opacity(amount * 0.66),
                                                                    DotsVoicePalette.colors[2].opacity(amount * 0.26)],
                                                           startPoint: .topLeading, endPoint: .bottomTrailing), lineWidth: 1))
                .shadow(color: DotsVoicePalette.colors[1].opacity(amount * 0.08), radius: 12, y: 6)
            }
            .allowsHitTesting(false).accessibilityHidden(true)
        }
    }

    private func drawMaterial(context: inout GraphicsContext, size: CGSize, amount: Double, time: Double) {
        guard amount > 0.001, size.width > 0, size.height > 0 else { return }
        let width = Double(size.width), height = Double(size.height)
        let rect = CGRect(origin: .zero, size: size)
        let drift = sin(time * 0.12) * width * 0.025
        let spread = 15 + (width * 0.72 - 15) * amount
        context.drawLayer { field in
            let stops: [Gradient.Stop] = zip([0.0, 0.23, 0.48, 0.73, 1.0], [4, 0, 1, 2, 3]).map {
                .init(color: DotsVoicePalette.colors[$0.1].opacity(amount * 0.30), location: $0.0)
            }
            field.fill(Path(rect), with: .linearGradient(Gradient(stops: stops),
                       startPoint: CGPoint(x: -width * 0.035 + drift, y: 0),
                       endPoint: CGPoint(x: width * 1.035 + drift, y: 0)))
            field.blendMode = .screen
            drawPool(context: &field, x: width * (0.20 + sin(time * 0.21) * 0.035), y: height * 0.34,
                     radiusX: width * 0.48, radiusY: height * 1.5,
                     color: Color(red: 102.0 / 255, green: 224.0 / 255, blue: 1), alpha: amount * 0.13)
            drawPool(context: &field, x: width * (0.80 + cos(time * 0.17 + 1.3) * 0.035), y: height * 0.95,
                     radiusX: width * 0.48, radiusY: height * 1.6,
                     color: Color(red: 1, green: 123.0 / 255, blue: 183.0 / 255), alpha: amount * 0.10)
            field.blendMode = .normal
            drawPool(context: &field, x: width * (0.30 + sin(time * 0.18) * 0.055), y: 2,
                     radiusX: width * 0.31, radiusY: min(13, height * 0.20),
                     color: DotsVoicePalette.glint, alpha: amount * 0.45)
            drawPool(context: &field, x: width * (0.72 + cos(time * 0.15) * 0.045), y: height - 1,
                     radiusX: width * 0.28, radiusY: min(11, height * 0.17),
                     color: DotsVoicePalette.colors[2], alpha: amount * 0.30)
            if amount < 0.999 {
                field.blendMode = .destinationIn
                let outerAlpha = DotsVoiceMaterialState.smooth((amount - 0.55) / 0.45)
                let mask = Gradient(stops: [.init(color: .black, location: 0),
                                            .init(color: .black, location: 0.66),
                                            .init(color: .black.opacity(outerAlpha), location: 1)])
                field.fill(Path(rect), with: .radialGradient(mask,
                           center: CGPoint(x: width / 2, y: 3), startRadius: spread * 0.08, endRadius: spread))
            }
        }
        drawGlassRipples(context: &context, width: width, height: height)
        drawLastGrain(context: &context, width: width, height: height, amount: amount)
        for line in 0..<4 {
            var path = Path()
            for x in stride(from: 0.0, through: width, by: 8) {
                let y = height - 3 + sin(x * 0.012 + time * 0.6 + Double(line)) * 2 - Double(line) * 2
                let point = CGPoint(x: x, y: y)
                if x == 0 { path.move(to: point) } else { path.addLine(to: point) }
            }
            context.stroke(path, with: .color(DotsVoicePalette.colors[line].opacity(amount * 0.12)), lineWidth: 0.7)
        }
    }

    private func drawPool(context: inout GraphicsContext, x: Double, y: Double,
                          radiusX: Double, radiusY: Double, color: Color, alpha: Double,
                          shoulder: Double = 0.62) {
        guard radiusX > 0, radiusY > 0, alpha > 0 else { return }
        var pool = context
        pool.translateBy(x: x, y: y)
        pool.scaleBy(x: radiusX, y: radiusY)
        let glow = Gradient(stops: [.init(color: color.opacity(alpha), location: 0),
                                    .init(color: color.opacity(alpha * shoulder), location: 0.45),
                                    .init(color: color.opacity(0), location: 1)])
        pool.fill(Path(CGRect(x: -1, y: -1, width: 2, height: 2)),
                  with: .radialGradient(glow, center: .zero, startRadius: 0, endRadius: 1))
    }

    private func drawLastGrain(context: inout GraphicsContext, width: Double, height: Double, amount: Double) {
        guard !reducedMotion, let finish = presentation.material.lastGrain else { return }
        let phase = finish.phase
        let distance = finish.rising ? 72 * (1 - phase) : 8 + 67 * phase
        let radius = finish.rising ? 32 - 22 * phase : 12 + 20 * phase
        let strength = finish.strength * (finish.rising ? sqrt(DotsVoiceMaterialState.clamp(amount)) : 1)
        var sheen = context
        sheen.clip(to: Path(CGRect(x: 0, y: 0, width: width, height: min(12, height))))
        for side in [-1.0, 1.0] {
            drawPool(context: &sheen, x: width / 2 + side * distance, y: 4,
                     radiusX: radius, radiusY: 3 + sin(phase * .pi) * 2,
                     color: DotsVoicePalette.colors[side < 0 ? 4 : 2], alpha: strength * 0.12,
                     shoulder: 0.05 / 0.12)
        }
    }

    private func drawGlassRipples(context: inout GraphicsContext, width: Double, height: Double) {
        guard presentation.form == .draining, !reducedMotion else { return }
        let contact = DotsVoiceMaterialState.clamp((presentation.progress - 0.13) / 0.87)
        guard contact > 0, contact < 1 else { return }
        let envelope = DotsVoiceMaterialState.smooth(contact / 0.10) * DotsVoiceMaterialState.smooth((1 - contact) / 0.18)
        let reach = min(width / 2 - 26, 220)
        guard reach >= 28 else { return }
        let center = width / 2
        var ripple = context
        ripple.clip(to: Path(CGRect(x: 0, y: 0, width: width, height: min(12, height))))
        let depression = 2.6 * sin(contact * .pi)
        drawRipple(context: &ripple, center: center, reach: reach, x: center, halfWidth: 28,
                   strength: envelope * sin(contact * .pi)) { offset in
            depression * exp(-pow(offset / 15, 2))
        }
        for start in [0.0, 0.32] {
            let age = (contact - start) / 0.68
            guard age > 0, age < 1 else { continue }
            let amplitude = pow(sin(age * .pi), 2) * exp(-1.2 * age)
            let front = 10 + (reach - 10) * age
            for side in [-1.0, 1.0] {
                drawRipple(context: &ripple, center: center, reach: reach, x: center + side * front,
                           halfWidth: 19, strength: envelope * amplitude) { offset in
                    2.1 * amplitude * cos(offset * 0.16) * exp(-pow(offset / 18, 2))
                }
            }
        }
    }

    private func drawRipple(context: inout GraphicsContext, center: Double, reach: Double, x: Double,
                            halfWidth: Double, strength: Double, profile: (Double) -> Double) {
        guard strength >= 0.001 else { return }
        var path = Path()
        for step in 0...24 {
            let offset = (Double(step) / 12 - 1) * halfWidth
            let point = CGPoint(x: x + offset, y: 3 + profile(offset))
            if step == 0 { path.move(to: point) } else { path.addLine(to: point) }
        }
        let index = min(3, max(0, Int(((x - center + reach) / (2 * reach) * 3).rounded())))
        let color = DotsVoicePalette.colors[index]
        let tint = Gradient(stops: [.init(color: color.opacity(0), location: 0),
                                    .init(color: color.opacity(strength * 0.34), location: 0.35),
                                    .init(color: color.opacity(strength * 0.34), location: 0.65),
                                    .init(color: color.opacity(0), location: 1)])
        context.stroke(path, with: .linearGradient(tint,
                       startPoint: CGPoint(x: x - halfWidth, y: 0), endPoint: CGPoint(x: x + halfWidth, y: 0)),
                       style: StrokeStyle(lineWidth: 0.8, lineCap: .round, lineJoin: .round))
    }
}


/// The only touch target that restores the orb; normal editor taps remain normal.
struct DotsVoiceFlowHandle: View {
    @ObservedObject var presentation: DotsVoicePresentation
    var travel: CGFloat
    @GestureState private var touching = false
    @Environment(\.accessibilityReduceMotion) private var reducedMotion
    var body: some View {
        if presentation.active && presentation.visible && (presentation.progress > 0.05 || presentation.form == .dragging) {
            let ready = presentation.form == .fused || presentation.form == .dragging
            // Fade the visible band, never its gesture container. A full pull
            // keeps the same recognizer alive until the finger is released.
            ZStack {
                Capsule().fill(LinearGradient(colors: [.clear] + DotsVoicePalette.horizontal + [.clear], startPoint: .leading, endPoint: .trailing))
                    .frame(width: 112, height: touching ? 5 : 3)
                    .shadow(color: DotsVoicePalette.colors[2].opacity(touching ? 0.32 : 0.14), radius: touching ? 8 : 4, y: -1)
                    .opacity(presentation.material.materialAmount)
            }
                .frame(width: 126, height: 28)
                .contentShape(Rectangle())
                .allowsHitTesting(ready)
                .gesture(DragGesture(minimumDistance: 5)
                    .updating($touching) { _, value, _ in value = true }
                    .onChanged { presentation.dragChanged(translation: $0.translation, travel: presentation.measuredTravel ?? travel) }
                    .onEnded { _ in presentation.dragEnded(travel: presentation.measuredTravel ?? travel) })
                .accessibilityElement().accessibilityLabel("向上拖动流光，重新凝聚语音球")
                .accessibilityAddTraits(.isButton)
                .accessibilityAction { presentation.expandAccessibly() }
                .accessibilityIdentifier("dots-voice-flow-handle")
                .onAppear { presentation.setReducedMotion(reducedMotion) }
                .onChange(of: reducedMotion) { _, value in presentation.setReducedMotion(value) }
        }
    }
}
