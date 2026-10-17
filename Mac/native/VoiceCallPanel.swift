import AppKit
import Foundation
import CoreFoundation
import ImageIO

// This is a presentation of the existing web-owned call. It never acquires an
// audio device, starts a request, or creates an independent call state machine.
struct VoiceCallPresentation: Equatable {
    struct PetState: Equatable {
        let name: String
        let row: Int
        let fps: Double
        let frames: Int
    }

    struct Pet: Equatable {
        let id: String
        let spriteURL: String
        let cellWidth: Int
        let cellHeight: Int
        let spriteVersion: Int
        let states: [PetState]

        func resourceURL(relativeTo base: URL) -> URL? {
            guard base.scheme == "http", base.user == nil, base.password == nil,
                  ["127.0.0.1", "localhost", "::1"].contains(base.host?.lowercased() ?? ""),
                  let resource = URL(string: spriteURL, relativeTo: base)?.absoluteURL,
                  resource.scheme == base.scheme, resource.host == base.host,
                  resource.port == base.port, resource.user == nil, resource.password == nil,
                  resource.query == nil, resource.fragment == nil else { return nil }
            return resource
        }
    }

    let callID: String
    let startedAt: Double // JavaScript epoch milliseconds, not a render counter.
    let muted: Bool
    let name: String
    let phase: String
    let pet: Pet?

    private static func number(_ value: Any?) -> Double? {
        guard let number = value as? NSNumber,
              CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
        let result = number.doubleValue
        return result.isFinite ? result : nil
    }

    private static func integer(_ value: Any?, range: ClosedRange<Int>) -> Int? {
        guard let number = number(value), number.rounded(.towardZero) == number,
              number >= Double(range.lowerBound), number <= Double(range.upperBound) else { return nil }
        return Int(number)
    }

    private static func text(_ value: Any?, limit: Int, byteLimit: Int) -> String? {
        guard let text = value as? String, !text.isEmpty,
              text.count <= limit, text.utf8.count <= byteLimit,
              text.unicodeScalars.allSatisfy({ !CharacterSet.controlCharacters.contains($0) }) else { return nil }
        return text
    }

    init?(_ body: [String: Any]) {
        guard let callID = body["callId"] as? String, UUID(uuidString: callID) != nil,
              let startedAt = Self.number(body["startedAt"]), startedAt > 0,
              startedAt <= 4_102_444_800_000,
              let mutedNumber = body["muted"] as? NSNumber,
              CFGetTypeID(mutedNumber) == CFBooleanGetTypeID(),
              let name = Self.text(body["name"], limit: 40, byteLimit: 512),
              let phase = body["phase"] as? String,
              ["idle", "listening", "sending", "waiting", "starting", "speaking", "muted", "paused"].contains(phase) else { return nil }
        var parsedPet: Pet?
        if let value = body["pet"], !(value is NSNull) {
            guard let object = value as? [String: Any],
                  let id = Self.text(object["id"], limit: 128, byteLimit: 512),
                  let spriteURL = Self.text(object["spriteURL"], limit: 1024, byteLimit: 2048),
                  spriteURL.hasPrefix("/assets/dots-pets/"),
                  !spriteURL.contains("\\"), !spriteURL.contains("?"), !spriteURL.contains("#"),
                  let decoded = spriteURL.removingPercentEncoding,
                  !decoded.contains("%"), !decoded.contains("\\"),
                  decoded.hasPrefix("/assets/dots-pets/"),
                  decoded.unicodeScalars.allSatisfy({ !CharacterSet.controlCharacters.contains($0) }),
                  decoded.split(separator: "/", omittingEmptySubsequences: false).allSatisfy({ $0 != "." && $0 != ".." }),
                  let width = Self.integer(object["cellWidth"], range: 1...1024),
                  let height = Self.integer(object["cellHeight"], range: 1...1024),
                  let version = Self.integer(object["spriteVersion"], range: 1...4),
                  let stateObjects = object["states"] as? [[String: Any]],
                  !stateObjects.isEmpty, stateObjects.count <= 32 else { return nil }
            var states: [PetState] = []
            var stateNames = Set<String>()
            for state in stateObjects {
                guard let name = Self.text(state["name"], limit: 64, byteLimit: 128),
                      stateNames.insert(name).inserted,
                      let row = Self.integer(state["row"], range: 0...63),
                      let fps = Self.number(state["fps"]), fps > 0, fps <= 60,
                      let frames = Self.integer(state["frames"], range: 1...64) else { return nil }
                states.append(PetState(name: name, row: row, fps: fps, frames: frames))
            }
            parsedPet = Pet(id: id, spriteURL: spriteURL, cellWidth: width,
                            cellHeight: height, spriteVersion: version, states: states)
        }
        self.callID = callID
        self.startedAt = startedAt
        self.muted = mutedNumber.boolValue
        self.name = name
        self.phase = phase
        self.pet = parsedPet
    }

    func elapsedText(at now: Date) -> String {
        let elapsed = max(0, Int(floor(now.timeIntervalSince1970 - startedAt / 1000)))
        return String(format: "%02d:%02d", elapsed / 60, elapsed % 60)
    }
}

private final class VoiceCallPanelWindow: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

private final class VoiceCallPanelButton: NSButton {
    var capsuleColor = NSColor(srgbRed: 58 / 255, green: 58 / 255, blue: 58 / 255, alpha: 1)
    override var needsPanelToBecomeKey: Bool { false }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func draw(_ dirtyRect: NSRect) {
        let color = isHighlighted ? capsuleColor.blended(withFraction: 0.16, of: .black) ?? capsuleColor : capsuleColor
        color.setFill()
        NSBezierPath(roundedRect: bounds, xRadius: bounds.height / 2, yRadius: bounds.height / 2).fill()
        super.draw(dirtyRect)
    }
}

private final class VoiceCallPanelPetView: NSView {
    var sprite: CGImage? { didSet { frameImage = nil; needsDisplay = true } }
    private var frameImage: NSImage?
    private var frameKey = ""
    override var isFlipped: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    func displayFrame(row: Int, column: Int, width: Int, height: Int) {
        let key = "\(row):\(column):\(width):\(height)"
        guard key != frameKey || frameImage == nil else { return }
        frameKey = key
        guard let sprite = sprite,
              let crop = sprite.cropping(to: CGRect(x: CGFloat(column * width), y: CGFloat(row * height),
                                                  width: CGFloat(width), height: CGFloat(height))) else { return }
        frameImage = NSImage(cgImage: crop, size: NSSize(width: CGFloat(width), height: CGFloat(height)))
        needsDisplay = true
    }

    override func draw(_ dirtyRect: NSRect) {
        if let image = frameImage {
            image.draw(in: bounds, from: .zero, operation: .sourceOver, fraction: 1,
                       respectFlipped: true, hints: [.interpolation: NSImageInterpolation.high])
        } else {
            let symbol = NSImage(systemSymbolName: "sparkles", accessibilityDescription: nil)?
                .withSymbolConfiguration(NSImage.SymbolConfiguration(pointSize: 23, weight: .regular))
            symbol?.draw(in: bounds.insetBy(dx: 10, dy: 10), from: .zero, operation: .sourceOver,
                         fraction: 0.65, respectFlipped: true, hints: nil)
        }
    }
}

private final class VoiceCallPanelContent: NSView {
    let petView = VoiceCallPanelPetView()
    let nameLabel = NSTextField(labelWithString: "Dots")
    let timeLabel = NSTextField(labelWithString: "00:00")
    let muteButton = VoiceCallPanelButton()
    let endButton = VoiceCallPanelButton()
    var onDragEnded: (() -> Void)?
    override var isFlipped: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    init() {
        super.init(frame: NSRect(x: 0, y: 0, width: 300, height: 120))
        wantsLayer = true
        layer?.cornerRadius = 18
        layer?.masksToBounds = true
        layer?.backgroundColor = NSColor(srgbRed: 45 / 255, green: 45 / 255, blue: 45 / 255, alpha: 1).cgColor
        layer?.borderColor = NSColor(calibratedWhite: 0.28, alpha: 0.7).cgColor
        layer?.borderWidth = 0.7
        petView.frame = NSRect(x: 16, y: 13, width: 42, height: 42)
        nameLabel.frame = NSRect(x: 62, y: 13, width: 220, height: 23)
        nameLabel.font = .systemFont(ofSize: 15, weight: .semibold)
        nameLabel.textColor = NSColor(calibratedWhite: 0.97, alpha: 1)
        nameLabel.lineBreakMode = .byTruncatingTail
        timeLabel.frame = NSRect(x: 62, y: 37, width: 220, height: 20)
        timeLabel.font = .monospacedDigitSystemFont(ofSize: 14, weight: .regular)
        timeLabel.textColor = NSColor(calibratedWhite: 0.71, alpha: 1)
        for label in [nameLabel, timeLabel] { label.isSelectable = false }
        for (button, x) in [(muteButton, CGFloat(13)), (endButton, CGFloat(157))] {
            button.frame = NSRect(x: x, y: 71, width: 130, height: 35)
            button.isBordered = false
            button.bezelStyle = .regularSquare
            button.imagePosition = .imageOnly
            button.imageScaling = .scaleProportionallyDown
            button.focusRingType = .none
            button.contentTintColor = NSColor(calibratedWhite: 0.98, alpha: 1)
            addSubview(button)
        }
        endButton.capsuleColor = NSColor(srgbRed: 233 / 255, green: 44 / 255, blue: 41 / 255, alpha: 1)
        endButton.image = NSImage(systemSymbolName: "phone.down.fill", accessibilityDescription: nil)?
            .withSymbolConfiguration(NSImage.SymbolConfiguration(pointSize: 17, weight: .semibold))
        endButton.setAccessibilityLabel("挂断语音通话")
        endButton.toolTip = "挂断语音通话"
        addSubview(petView)
        addSubview(nameLabel)
        addSubview(timeLabel)
        setAccessibilityRole(.group)
        setAccessibilityLabel("Dots 语音通话")
    }

    required init?(coder: NSCoder) { return nil }

    override func mouseDown(with event: NSEvent) {
        window?.performDrag(with: event)
        onDragEnded?()
    }

    func update(_ value: VoiceCallPresentation, now: Date) {
        if nameLabel.stringValue != value.name {
            nameLabel.stringValue = value.name
            setAccessibilityLabel("与 \(value.name) 的语音通话")
        }
        let elapsed = value.elapsedText(at: now)
        if timeLabel.stringValue != elapsed { timeLabel.stringValue = elapsed }
        let label = value.muted ? "取消麦克风静音" : "静音麦克风"
        if muteButton.toolTip != label {
            muteButton.image = NSImage(systemSymbolName: value.muted ? "mic.slash.fill" : "mic.fill", accessibilityDescription: nil)?
                .withSymbolConfiguration(NSImage.SymbolConfiguration(pointSize: 18, weight: .medium))
            muteButton.toolTip = label
            muteButton.setAccessibilityLabel(label)
            muteButton.state = value.muted ? .on : .off
        }
    }
}

private final class VoiceCallPanelImageDelegate: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        // The trusted local resource route is the only request destination.
        completionHandler(nil)
    }
}

final class VoiceCallPanelController: NSObject {
    var onAction: ((String, String) -> Void)?
    private var panel: VoiceCallPanelWindow?
    private var content: VoiceCallPanelContent?
    private var presentation: VoiceCallPresentation?
    private var baseURL: URL?
    private var timer: Timer?
    private var screenObserver: NSObjectProtocol?
    private var spriteTask: URLSessionDownloadTask?
    private var spriteIdentity: String?
    private var requestedIdentity: String?
    private var requestGeneration = 0
    private var positioned = false
    private let imageSession: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.urlCache = nil
        configuration.timeoutIntervalForRequest = 8
        configuration.timeoutIntervalForResource = 12
        return URLSession(configuration: configuration, delegate: VoiceCallPanelImageDelegate(), delegateQueue: nil)
    }()

    override init() {
        super.init()
        screenObserver = NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification,
            object: nil, queue: .main) { [weak self] _ in self?.constrainToScreen() }
    }

    deinit {
        timer?.invalidate()
        spriteTask?.cancel()
        imageSession.invalidateAndCancel()
        if let observer = screenObserver { NotificationCenter.default.removeObserver(observer) }
    }

    func update(_ value: VoiceCallPresentation, baseURL: URL) {
        assert(Thread.isMainThread)
        let previousIdentity = resourceIdentity()
        let callChanged = presentation?.callID != value.callID
        presentation = value
        self.baseURL = baseURL
        let identity = resourceIdentity()
        if callChanged || identity != previousIdentity {
            cancelImageRequest()
            spriteIdentity = nil
            content?.petView.sprite = nil
        }
        content?.update(value, now: Date())
        if panel?.isVisible == true { loadPetIfNeeded(); tick(at: Date()) }
    }

    func show() {
        assert(Thread.isMainThread)
        guard presentation != nil else { return }
        makePanelIfNeeded()
        guard let panel = panel else { return }
        if !positioned, let screen = NSScreen.main ?? NSScreen.screens.first {
            let visible = screen.visibleFrame
            panel.setFrameOrigin(NSPoint(x: visible.maxX - panel.frame.width - 20,
                                         y: visible.maxY - panel.frame.height - 20))
            positioned = true
        }
        constrainToScreen()
        panel.orderFrontRegardless()
        tick(at: Date())
        loadPetIfNeeded()
        if timer == nil {
            let timer = Timer(timeInterval: 0.05, repeats: true) { [weak self] _ in
                guard let self = self, self.panel?.isVisible == true else { return }
                self.tick(at: Date())
            }
            self.timer = timer
            RunLoop.main.add(timer, forMode: .common)
        }
    }

    func hide() {
        assert(Thread.isMainThread)
        timer?.invalidate()
        timer = nil
        cancelImageRequest()
        panel?.orderOut(nil)
    }

    func clear() {
        hide()
        presentation = nil
        baseURL = nil
        spriteIdentity = nil
        content?.petView.sprite = nil
    }

    func close() {
        clear()
        panel?.close()
        panel = nil
        content = nil
        positioned = false
    }

    private func makePanelIfNeeded() {
        guard panel == nil else { return }
        let panel = VoiceCallPanelWindow(contentRect: NSRect(x: 0, y: 0, width: 300, height: 120),
            styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.isReleasedWhenClosed = false
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.level = .floating
        panel.isFloatingPanel = true
        panel.hidesOnDeactivate = false
        panel.becomesKeyOnlyIfNeeded = true
        panel.canHide = false
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
        panel.isMovableByWindowBackground = true
        panel.title = "Dots 语音通话"
        let content = VoiceCallPanelContent()
        content.muteButton.target = self
        content.muteButton.action = #selector(toggleMute)
        content.endButton.target = self
        content.endButton.action = #selector(endCall)
        content.onDragEnded = { [weak self] in self?.constrainToScreen() }
        panel.contentView = content
        self.panel = panel
        self.content = content
    }

    @objc private func toggleMute() {
        guard let value = presentation else { return }
        onAction?(value.callID, "mute")
    }

    @objc private func endCall() {
        guard let value = presentation else { return }
        onAction?(value.callID, "end")
    }

    private func tick(at now: Date) {
        guard let value = presentation, let content = content else { return }
        content.update(value, now: now)
        guard let pet = value.pet, let sprite = content.petView.sprite else { return }
        let columns = sprite.width / pet.cellWidth, rows = sprite.height / pet.cellHeight
        let stateName = ["sending", "waiting", "starting"].contains(value.phase) ? "running" :
            ["muted", "paused"].contains(value.phase) ? "waiting" : "idle"
        let state = pet.states.first(where: { $0.name == stateName }) ?? pet.states.first(where: { $0.name == "idle" }) ?? pet.states[0]
        var row = state.row
        var column = Int(floor(now.timeIntervalSince1970 * state.fps)).quotientAndRemainder(dividingBy: state.frames).remainder
        if pet.spriteVersion >= 2, rows >= 11, columns >= 8, let panel = panel {
            let cursor = content.petView.convert(panel.convertPoint(fromScreen: NSEvent.mouseLocation), from: nil)
            let dx = cursor.x - content.petView.bounds.midX, dy = cursor.y - content.petView.bounds.midY
            if hypot(dx, dy) > 16 {
                let degrees = (atan2(dx, -dy) * 180 / .pi + 360).truncatingRemainder(dividingBy: 360)
                let direction = Int((degrees / 22.5).rounded()) % 16
                row = 9 + direction / 8
                column = direction % 8
            }
        }
        guard row >= 0, row < rows, column >= 0, column < columns else { return }
        content.petView.displayFrame(row: row, column: column, width: pet.cellWidth, height: pet.cellHeight)
    }

    private func resourceIdentity() -> String? {
        guard let value = presentation, let pet = value.pet, let base = baseURL,
              let url = pet.resourceURL(relativeTo: base) else { return nil }
        return "\(value.callID)|\(pet.id)|\(url.absoluteString)|\(pet.cellWidth)|\(pet.cellHeight)|\(pet.spriteVersion)"
    }

    private func cancelImageRequest() {
        requestGeneration += 1
        spriteTask?.cancel()
        spriteTask = nil
        requestedIdentity = nil
    }

    private func loadPetIfNeeded() {
        guard panel?.isVisible == true, let value = presentation, let pet = value.pet,
              let base = baseURL, let url = pet.resourceURL(relativeTo: base),
              let identity = resourceIdentity(), identity != spriteIdentity,
              identity != requestedIdentity else { return }
        cancelImageRequest()
        let generation = requestGeneration
        requestedIdentity = identity
        spriteTask = imageSession.downloadTask(with: url) { [weak self] temporary, response, error in
            var image: CGImage?
            if error == nil, let temporary = temporary,
               let response = response as? HTTPURLResponse, response.statusCode == 200,
               response.url == url, response.mimeType?.hasPrefix("image/") == true,
               let attributes = try? FileManager.default.attributesOfItem(atPath: temporary.path),
               let bytes = attributes[.size] as? NSNumber, bytes.int64Value > 0, bytes.int64Value <= 16 * 1024 * 1024,
               let data = try? Data(contentsOf: temporary, options: .mappedIfSafe),
               let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
               let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
               let width = properties[kCGImagePropertyPixelWidth] as? NSNumber,
               let height = properties[kCGImagePropertyPixelHeight] as? NSNumber,
               width.intValue >= pet.cellWidth, height.intValue >= pet.cellHeight,
               width.intValue <= 16384, height.intValue <= 16384,
               width.int64Value * height.int64Value <= 32 * 1024 * 1024,
               width.intValue % pet.cellWidth == 0, height.intValue % pet.cellHeight == 0,
               pet.states.allSatisfy({ $0.row < height.intValue / pet.cellHeight && $0.frames <= width.intValue / pet.cellWidth }) {
                image = CGImageSourceCreateImageAtIndex(source, 0, [kCGImageSourceShouldCacheImmediately: true] as CFDictionary)
            }
            DispatchQueue.main.async { [weak self] in
                guard let self = self, self.requestGeneration == generation,
                      self.resourceIdentity() == identity, self.panel?.isVisible == true else { return }
                self.spriteTask = nil
                // Remember a failed resource for this presentation too: a bad
                // asset must not be re-requested every time a speech phase moves.
                self.spriteIdentity = identity
                self.requestedIdentity = nil
                self.content?.petView.sprite = image
                self.tick(at: Date())
            }
        }
        spriteTask?.resume()
    }

    private func constrainToScreen() {
        guard let panel = panel, !NSScreen.screens.isEmpty else { return }
        let current = panel.frame
        let screens = NSScreen.screens
        let screen = screens.max { left, right in
            let a = current.intersection(left.visibleFrame), b = current.intersection(right.visibleFrame)
            return max(0, a.width) * max(0, a.height) < max(0, b.width) * max(0, b.height)
        } ?? screens[0]
        let visible = screen.visibleFrame.insetBy(dx: 8, dy: 8)
        let x = min(max(current.minX, visible.minX), max(visible.minX, visible.maxX - current.width))
        let y = min(max(current.minY, visible.minY), max(visible.minY, visible.maxY - current.height))
        if x != current.minX || y != current.minY { panel.setFrameOrigin(NSPoint(x: x, y: y)) }
    }

    #if SHIYAN_CALL_PANEL_TESTS
    var testVisible: Bool { panel?.isVisible == true }
    var testTimerActive: Bool { timer != nil }
    var testImageRequestActive: Bool { spriteTask != nil }
    var testHasImage: Bool { content?.petView.sprite != nil }
    var testTime: String? { content?.timeLabel.stringValue }
    var testName: String? { content?.nameLabel.stringValue }
    var testMuteLabel: String? { content?.muteButton.toolTip }
    var testCanBecomeKey: Bool { panel?.canBecomeKey == true }
    var testDelegateIsNil: Bool { panel?.delegate == nil }
    var testFrame: NSRect? { panel?.frame }
    var testNameFrame: NSRect? { content?.nameLabel.frame }
    var testPetFrame: NSRect? { content?.petView.frame }
    func testTick(at now: Date) { tick(at: now) }
    func testClickMute() { content?.muteButton.performClick(nil) }
    func testClickEnd() { content?.endButton.performClick(nil) }
    func testMove(to point: NSPoint) { panel?.setFrameOrigin(point); constrainToScreen() }
    func testInstallImage(_ image: CGImage) {
        cancelImageRequest()
        spriteIdentity = resourceIdentity()
        content?.petView.sprite = image
        tick(at: Date())
    }
    func testWriteScreenshot(to url: URL) throws {
        guard let content = content,
              let bitmap = content.bitmapImageRepForCachingDisplay(in: content.bounds) else { return }
        content.cacheDisplay(in: content.bounds, to: bitmap)
        guard let data = bitmap.representation(using: .png, properties: [:]) else { return }
        try data.write(to: url)
    }
    #endif
}
