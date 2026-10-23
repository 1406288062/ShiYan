import AppKit
import WebKit
import Foundation
import AVFoundation
import Speech
import Quartz
import Darwin

private let appBundleID = "com.shiyan.image-enhancer.desktop"

// Native messages are untrusted, including messages from the application's own page.
// Host workspace access requires the owner; bounded voice and explicitly
// selected account attachments require an active verified account.
private final class NativeAccountGate: NSObject, WKHTTPCookieStoreObserver, URLSessionTaskDelegate {
    struct Permit: Equatable { let cookie: String; let generation: UUID }
    private let store: WKHTTPCookieStore
    private let baseURL: () -> URL?
    private let onRevoke: () -> Void
    private var observedCookie: String?
    private var generation = UUID()
    private var permit: Permit?
    private var timer: Timer?
    private var verifiedAt: TimeInterval = 0
    private var hostAllowed = false
    private struct Validation {
        let id = UUID()
        let permit: Permit
        var callbacks: [(Permit?) -> Void]
    }
    private var validation: Validation?
    private var validationTask: URLSessionDataTask?
    private var cookieCallbacks: [(String?) -> Void] = []
    private lazy var session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForRequest = 15
        return URLSession(configuration: configuration, delegate: self, delegateQueue: .main)
    }()
    init(store: WKHTTPCookieStore, baseURL: @escaping () -> URL?, onRevoke: @escaping () -> Void) {
        self.store = store; self.baseURL = baseURL; self.onRevoke = onRevoke
        super.init()
        store.add(self)
        timer = Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { [weak self] _ in
            guard let self = self, self.permit != nil else { return }
            self.authorize { _ in }
        }
    }
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
    private func cookie(_ completion: @escaping (String?) -> Void) {
        cookieCallbacks.append(completion)
        guard cookieCallbacks.count == 1 else { return }
        store.getAllCookies { [weak self] cookies in
            guard let self = self else { return }
            let value = cookies.first { $0.name == "shiyan_account_session" && $0.domain == "127.0.0.1" && $0.path == "/" }?.value
            if self.observedCookie != value {
                self.observedCookie = value
                self.revoke()
            }
            let callbacks = self.cookieCallbacks
            self.cookieCallbacks.removeAll()
            callbacks.forEach { $0(value) }
        }
    }
    func cookiesDidChange(in cookieStore: WKHTTPCookieStore) { cookie { _ in } }
    private func revoke() {
        generation = UUID(); permit = nil; verifiedAt = 0; hostAllowed = false
        let callbacks = validation?.callbacks ?? []
        validation = nil; validationTask?.cancel(); validationTask = nil
        onRevoke()
        callbacks.forEach { $0(nil) }
    }
    func authorizeUser(_ completion: @escaping (Permit?) -> Void) {
        authorize(completion, requireHost: false)
    }
    func authorize(_ callback: @escaping (Permit?) -> Void, requireHost: Bool = true) {
        let completion: (Permit?) -> Void = { [weak self] permit in
            callback(requireHost && self?.hostAllowed != true ? nil : permit)
        }
        cookie { [weak self] cookie in
            guard let self = self, let cookie = cookie, let base = self.baseURL() else { completion(nil); return }
            let attempt = Permit(cookie: cookie, generation: self.generation)
            if self.permit == attempt && ProcessInfo.processInfo.systemUptime - self.verifiedAt < 1 {
                completion(attempt); return
            }
            if self.validation?.permit == attempt {
                self.validation?.callbacks.append(completion); return
            }
            let pending = Validation(permit: attempt, callbacks: [completion])
            self.validation = pending
            var request = URLRequest(url: base.appendingPathComponent("api/auth/me"))
            request.setValue("shiyan_account_session=" + cookie, forHTTPHeaderField: "Cookie")
            request.setValue("application/json", forHTTPHeaderField: "Accept")
            self.validationTask = self.session.dataTask(with: request) { [weak self] data, response, error in
                guard let self = self else { return }
                self.cookie { current in
                    guard self.validation?.id == pending.id else { return }
                    let callbacks = self.validation?.callbacks ?? []
                    self.validation = nil; self.validationTask = nil
                    guard current == attempt.cookie, self.generation == attempt.generation,
                          error == nil, let response = response as? HTTPURLResponse, response.statusCode == 200,
                          response.url == request.url, let data = data, data.count <= 64 * 1024,
                          let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
                          let user = object["user"] as? [String: Any], user["status"] as? String == "active" else {
                        self.revoke(); callbacks.forEach { $0(nil) }; return
                    }
                    self.hostAllowed = user["role"] as? String == "admin" && user["serverAccess"] as? Bool == true && user["owner"] as? String == "shiyan-private-owner"
                    self.permit = attempt; self.verifiedAt = ProcessInfo.processInfo.systemUptime
                    callbacks.forEach { $0(attempt) }
                }
            }
            self.validationTask?.resume()
        }
    }
    func authorizePresentation(_ completion: @escaping (Permit?) -> Void) {
        cookie { [weak self] current in
            guard let self = self else { completion(nil); return }
            if self.hostAllowed, let expected = self.permit, current == expected.cookie,
               self.generation == expected.generation,
               ProcessInfo.processInfo.systemUptime - self.verifiedAt < 15 {
                completion(expected)
            } else {
                self.authorize(completion)
            }
        }
    }
    func revalidate(_ expected: Permit, _ completion: @escaping (Bool) -> Void) {
        authorize({ completion($0 == expected) }, requireHost: false)
    }
    func deliver(_ action: @escaping () -> Void) {
        guard let expected = permit else { return }
        cookie { [weak self] value in
            guard let self = self, value == expected.cookie, self.permit == expected,
                  self.generation == expected.generation else { return }
            action()
        }
    }
    func request(_ url: URL, permit: Permit) -> URLRequest {
        var request = URLRequest(url: url)
        request.setValue("shiyan_account_session=" + permit.cookie, forHTTPHeaderField: "Cookie")
        return request
    }
    func fetch(_ request: URLRequest, completion: @escaping (Data?, URLResponse?, Error?) -> Void) -> URLSessionDataTask {
        let task = session.dataTask(with: request, completionHandler: completion); task.resume(); return task
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate,
                         WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler,
                         WKDownloadDelegate, QLPreviewPanelDataSource, QLPreviewPanelDelegate {
    private var window: NSWindow!
    private var startupPanel: NSPanel?
    private var startupFinished = false
    private let startupStartedAt = ProcessInfo.processInfo.systemUptime
    private var webView: WKWebView!
    private var browserWorkspace: BrowserWorkspace?
    private var nativeTransfers: [UUID: URLSessionDataTask] = [:]
    private lazy var accountGate = NativeAccountGate(store: webView.configuration.websiteDataStore.httpCookieStore,
        baseURL: { [weak self] in self?.baseURL }, onRevoke: { [weak self] in self?.revokeNativeAccount() })
    private func revokeNativeAccount() {
        suspendVoiceSession(); messagePlayback.cancel()
        browserWorkspace?.closeAll()
        for task in nativeTransfers.values { task.cancel() }; nativeTransfers.removeAll()
        for download in activeDownloads.values { download.cancel { _ in } }; activeDownloads.removeAll()
        savedFiles.removeAll(); previewURL = nil; sharingPicker = nil
        if QLPreviewPanel.sharedPreviewPanelExists() { QLPreviewPanel.shared()?.orderOut(nil) }
        for sheet in window?.sheets ?? [] { window?.endSheet(sheet, returnCode: .cancel) }
    }
    private var workbenchTestStarted = false
    private var backend: Process?
    private var backendPID: pid_t = 0
    private var backendGroupOwned = false
    private var readyTimer: Timer?
    private var readyURL: URL!
    private var baseURL: URL?
    private var port = 0
    private var lockFD: Int32 = -1
    private var quitting = false
    private var startedAt = Date()
    private var startupLog: FileHandle?
    private let speech = SpeechController()
    private let voicePlayback = QwenVoicePlaybackController()
    private let messagePlayback = VoicePlaybackController()
    private var activeVoiceCallID: String?
    private var voiceCallPresentation: VoiceCallPresentation?
    private lazy var voiceCallPanel: VoiceCallPanelController = {
        let controller = VoiceCallPanelController()
        controller.onAction = { [weak self] callID, action in
            guard let self = self, self.activeVoiceCallID == callID,
                  self.window?.isMiniaturized == true else { return }
            if action == "end" {
                self.suspendVoiceSession()
            } else if action == "mute" {
                self.emit(["type": "dotsCallPanelAction", "callId": callID, "action": "mute"])
            }
        }
        return controller
    }()
    private var savedFiles: [String: URL] = [:]
    private var activeDownloads: [ObjectIdentifier: WKDownload] = [:]
    private var previewURL: URL?
    private var previewDirectory: URL!
    private var selfTestWritten = false
    private var sharingPicker: NSSharingServicePicker?

    private var dataDirectory: URL {
        if let override = ProcessInfo.processInfo.environment["SHIYAN_DATA_DIR"], !override.isEmpty {
            return URL(fileURLWithPath: override, isDirectory: true)
        }
        return FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/image_enhancer", isDirectory: true)
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        do {
            try FileManager.default.createDirectory(at: dataDirectory, withIntermediateDirectories: true)
            let lock = dataDirectory.appendingPathComponent("desktop.lock")
            lockFD = Darwin.open(lock.path, O_CREAT | O_RDWR, S_IRUSR | S_IWUSR)
            guard lockFD >= 0 else { throw NSError(domain: "ShiYan", code: 1,
                                                   userInfo: [NSLocalizedDescriptionKey: "无法打开应用运行锁。"]) }
            if flock(lockFD, LOCK_EX | LOCK_NB) != 0 {
                NSRunningApplication.runningApplications(withBundleIdentifier: appBundleID)
                    .first(where: { $0.processIdentifier != getpid() })?
                    .activate(options: [.activateAllWindows])
                NSApp.terminate(nil)
                return
            }
            let runtime = dataDirectory.appendingPathComponent("runtime", isDirectory: true)
            try FileManager.default.createDirectory(at: runtime, withIntermediateDirectories: true)
            readyURL = runtime.appendingPathComponent("ready-\(UUID().uuidString).json")
            previewDirectory = runtime.appendingPathComponent("previews-\(UUID().uuidString)", isDirectory: true)
            try FileManager.default.createDirectory(at: previewDirectory, withIntermediateDirectories: true)
            buildMenus()
            buildWindow()
            speech.emit = { [weak self] detail in self?.emit(detail) }
            voicePlayback.emit = { [weak self] detail in self?.emit(detail) }
            messagePlayback.emit = { [weak self] detail in self?.emit(detail) }
            try launchBackend()
        } catch {
            showError("拾燕无法启动", message: error.localizedDescription)
            NSApp.terminate(nil)
        }
    }

    private func buildMenus() {
        let menu = NSMenu()
        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "关于拾燕", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "隐藏拾燕", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(withTitle: "显示全部", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "退出拾燕", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        menu.addItem(appItem)

        let fileItem = NSMenuItem()
        let fileMenu = NSMenu(title: "文件")
        let new = fileMenu.addItem(withTitle: "新建会话", action: #selector(newConversation), keyEquivalent: "n")
        new.target = self
        let open = fileMenu.addItem(withTitle: "添加图片或文件…", action: #selector(openFiles), keyEquivalent: "o")
        open.target = self
        fileMenu.addItem(.separator())
        fileMenu.addItem(withTitle: "关闭窗口", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        fileItem.submenu = fileMenu
        menu.addItem(fileItem)

        let editItem = NSMenuItem()
        let editMenu = NSMenu(title: "编辑")
        editMenu.addItem(withTitle: "撤销", action: Selector(("undo:")), keyEquivalent: "z")
        let redo = editMenu.addItem(withTitle: "重做", action: Selector(("redo:")), keyEquivalent: "Z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        editMenu.addItem(.separator())
        editMenu.addItem(withTitle: "剪切", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "复制", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "粘贴", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "全选", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = editMenu
        menu.addItem(editItem)

        let windowItem = NSMenuItem()
        let windowMenu = NSMenu(title: "窗口")
        windowMenu.addItem(withTitle: "最小化", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: "缩放", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        let reopen = windowMenu.addItem(withTitle: "显示拾燕", action: #selector(showWindow), keyEquivalent: "0")
        reopen.target = self
        windowMenu.addItem(.separator())
        windowMenu.addItem(withTitle: "前置全部窗口", action: #selector(NSApplication.arrangeInFront(_:)), keyEquivalent: "")
        windowItem.submenu = windowMenu
        menu.addItem(windowItem)
        NSApp.mainMenu = menu
        NSApp.windowsMenu = windowMenu
    }

    private func buildWindow() {
        let windowStyle: NSWindow.StyleMask = [.titled, .closable, .miniaturizable, .resizable]
        let initialContent = NSWindow.contentRect(forFrameRect: NSRect(x: 0, y: 0, width: 1440, height: 900), styleMask: windowStyle)
        window = NSWindow(contentRect: initialContent, styleMask: windowStyle,
                          backing: .buffered, defer: false)
        window.title = "拾燕"
        window.minSize = NSSize(width: 780, height: 660)
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.tabbingMode = .disallowed
        window.collectionBehavior = [.fullScreenPrimary]
        if CommandLine.arguments.contains(where: { $0.hasPrefix("--self-test") }) {
            window.center()
        } else {
            if !window.setFrameUsingName("ShiYanDesktopMainWindowV1") { window.center() }
            window.setFrameAutosaveName("ShiYanDesktopMainWindowV1")
        }
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        config.preferences.javaScriptCanOpenWindowsAutomatically = false
        config.userContentController.add(self, name: "native")
        let injected = """
        window.__SHIYAN_NATIVE__ = true;
        const markNative = () => {
          document.documentElement.classList.add('native-app');
          if (document.body) document.body.classList.add('native-app');
        };
        markNative();
        document.addEventListener('DOMContentLoaded', markNative, {once:true});
        """
        config.userContentController.addUserScript(WKUserScript(source: injected,
            injectionTime: .atDocumentStart, forMainFrameOnly: true))
        webView = WKWebView(frame: window.contentView!.bounds, configuration: config)
        webView.autoresizingMask = [.width, .height]
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = false
        if #available(macOS 13.3, *) { webView.isInspectable = false }
        let host = NSView(frame: webView.frame)
        host.autoresizingMask = [.width, .height]
        webView.frame = host.bounds
        host.addSubview(webView)
        window.contentView = host
        browserWorkspace = BrowserWorkspace(host: host, window: window, directory: dataDirectory,
            isInternal: { [weak self] url in
                guard let self = self else { return true }
                return self.port > 0 && url.port == self.port && ["127.0.0.1", "localhost", "::1"].contains(url.host?.lowercased() ?? "")
            }, emit: { [weak self] detail in self?.emit(detail) },
            authorize: { [weak self] completion in
                guard let self = self else { completion(false); return }
                self.accountGate.authorize { completion($0 != nil) }
            })
        _ = accountGate
        webView.isHidden = true
        showStartupPanel()
    }

    private func showStartupPanel() {
        let panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 320, height: 320),
                            styleMask: [.borderless], backing: .buffered, defer: false)
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.isReleasedWhenClosed = false
        panel.level = .floating
        if let screen = window.screen ?? NSScreen.main ?? NSScreen.screens.first {
            let display = screen.frame
            panel.setFrameOrigin(NSPoint(x: display.midX - panel.frame.width / 2,
                                         y: display.midY - panel.frame.height / 2))
        }
        let image = NSImageView(frame: NSRect(x: 60, y: 60, width: 200, height: 200))
        image.imageScaling = .scaleProportionallyUpOrDown
        if let resources = Bundle.main.resourceURL {
            image.image = NSImage(contentsOf: resources.appendingPathComponent("app/web/assets/logo.png"))
        }
        let content = NSView(frame: NSRect(x: 0, y: 0, width: 320, height: 320))
        content.addSubview(image)
        panel.contentView = content
        startupPanel = panel
        panel.orderFrontRegardless()
        NSApp.activate(ignoringOtherApps: true)
        if CommandLine.arguments.contains("--self-test") {
            let displayFrame = panel.screen?.frame ?? .zero
            let logoFrame = panel.convertToScreen(image.convert(image.bounds, to: nil))
            let report: [String: Any] = ["transparent": !panel.isOpaque && panel.backgroundColor.alphaComponent == 0,
                "shadow": panel.hasShadow, "logoLoaded": image.image != nil,
                "logoCentered": image.frame.midX == content.bounds.midX && image.frame.midY == content.bounds.midY,
                "mainWindowHidden": !window.isVisible,
                "screenCentered": panel.screen != nil && abs(logoFrame.midX - displayFrame.midX) < 0.5 && abs(logoFrame.midY - displayFrame.midY) < 0.5,
                "screenCenter": [displayFrame.midX, displayFrame.midY],
                "logoCenter": [logoFrame.midX, logoFrame.midY],
                "screenFrame": [displayFrame.minX, displayFrame.minY, displayFrame.width, displayFrame.height]]
            if let data = try? JSONSerialization.data(withJSONObject: report) {
                try? data.write(to: dataDirectory.appendingPathComponent("startup-self-test.json"))
            }
        }
    }

    private func finishStartup() {
        guard !startupFinished else { return }
        startupFinished = true
        webView?.isHidden = false
        startupPanel?.close()
        startupPanel = nil
        showWindow()
        if let webView = webView, CommandLine.arguments.contains(where: { $0.hasPrefix("--self-test") }) { self.webView(webView, didFinish: nil) }
    }

    private func waitForWorkbench(attempt: Int = 0) {
        guard !startupFinished else { return }
        // Present either a usable conversation or the sign-in form. The
        // fullscreen authentication spinner is not a separate app window.
        let readinessScript = """
        (() => {
          const gate = document.getElementById('accountGate');
          const login = !!gate && !gate.hidden;
          const conversation = document.documentElement.classList.contains('account-ready') &&
            !!window.shiyan?.getState?.() && typeof window.workbench?.getLayout === 'function';
          return {ready: login || conversation, screen: conversation ? 'conversation' : login ? 'login' : 'waiting',
            pageMs: performance.now(), authMs: window.__ShiYanAccountTimings?.authReady || 0,
            scriptsMs: window.__ShiYanAccountTimings?.scriptsReady || 0};
        })()
        """
        webView.evaluateJavaScript(readinessScript) { [weak self] value, _ in
            guard let self = self else { return }
            if var report = value as? [String: Any], report["ready"] as? Bool == true {
                report["nativeSeconds"] = ProcessInfo.processInfo.systemUptime - self.startupStartedAt
                report["nativePID"] = Int(getpid())
                report["backendPID"] = Int(self.backendPID)
                report["at"] = Date().timeIntervalSince1970
                if let data = try? JSONSerialization.data(withJSONObject: report, options: [.sortedKeys]),
                   let line = String(data: data, encoding: .utf8) {
                    self.startupLog?.write(Data(("SHIYAN_STARTUP " + line + "\n").utf8))
                    try? data.write(to: self.dataDirectory.appendingPathComponent("runtime/startup-latest.json"), options: .atomic)
                }
                self.finishStartup()
            }
            else if attempt >= 150 {
                self.finishStartup()
                self.showError("工作台加载超时", message: "请退出后重试。")
            } else {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { self.waitForWorkbench(attempt: attempt + 1) }
            }
        }
    }

    private func launchBackend() throws {
        guard let resources = Bundle.main.resourceURL else {
            throw NSError(domain: "ShiYan", code: 2, userInfo: [NSLocalizedDescriptionKey: "应用资源不完整。"])
        }
        let framework = Bundle.main.bundleURL.appendingPathComponent("Contents/Frameworks/Python.framework/Versions/3.14")
        let python = framework.appendingPathComponent("bin/python3.14")
        let app = resources.appendingPathComponent("app")
        let script = app.appendingPathComponent("desktop_server.py")
        let helper = Bundle.main.bundleURL.appendingPathComponent("Contents/MacOS/ShiYanIdentity")
        guard FileManager.default.isExecutableFile(atPath: python.path),
              FileManager.default.fileExists(atPath: script.path),
              FileManager.default.isExecutableFile(atPath: helper.path) else {
            throw NSError(domain: "ShiYan", code: 3, userInfo: [NSLocalizedDescriptionKey: "应用缺少内置运行组件，请重新构建。"])
        }
        let logs = dataDirectory.appendingPathComponent("logs")
        try FileManager.default.createDirectory(at: logs, withIntermediateDirectories: true)
        let logURL = logs.appendingPathComponent("desktop-runtime.log")
        if !FileManager.default.fileExists(atPath: logURL.path) {
            FileManager.default.createFile(atPath: logURL.path, contents: nil)
        }
        startupLog = try FileHandle(forWritingTo: logURL)
        try startupLog?.seekToEnd()
        let process = Process()
        process.executableURL = python
        let bootstrap = """
        import os, runpy, sys, threading, time, signal
        try:
            os.setsid()
        except PermissionError:
            if os.getpgrp() != os.getpid():
                raise
        parent = int(os.environ["SHIYAN_PARENT_PID"])
        def watch_parent():
            while os.getppid() == parent:
                time.sleep(0.75)
            os.killpg(os.getpgrp(), signal.SIGTERM)
        threading.Thread(target=watch_parent, daemon=True).start()
        sys.argv = sys.argv[1:]
        runpy.run_path(sys.argv[0], run_name="__main__")
        """
        process.arguments = ["-B", "-u", "-c", bootstrap, script.path,
                             "--port", "0", "--ready-file", readyURL.path,
                             "--data-dir", dataDirectory.path]
        process.currentDirectoryURL = app
        var environment: [String: String] = [:]
        let current = ProcessInfo.processInfo.environment
        for key in ["HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL"] {
            if let value = current[key] { environment[key] = value }
        }
        environment["PATH"] = "/usr/bin:/bin:/usr/sbin:/sbin"
        environment["PYTHONHOME"] = framework.path
        environment["PYTHONPATH"] = app.path
        environment["PYTHONNOUSERSITE"] = "1"
        environment["PYTHONDONTWRITEBYTECODE"] = "1"
        environment["PYTHONUNBUFFERED"] = "1"
        environment["SHIYAN_IDENTITY_HELPER"] = helper.path
        environment["SHIYAN_PARENT_PID"] = String(getpid())
        environment["SHIYAN_PACKAGED"] = "1"
        environment["SSL_CERT_FILE"] = framework.appendingPathComponent("lib/python3.14/site-packages/certifi/cacert.pem").path
        if current["SHIYAN_OFFLINE_TEST"] == "1" && CommandLine.arguments.contains(where: { $0.hasPrefix("--self-test") }) {
            environment["SHIYAN_OFFLINE_TEST"] = "1"
        }
        process.environment = environment
        process.standardOutput = startupLog
        process.standardError = startupLog
        process.terminationHandler = { [weak self] proc in
            DispatchQueue.main.async {
                guard let self = self, !self.quitting else { return }
                self.readyTimer?.invalidate()
                self.suspendVoiceSession()
                self.showError("本地服务已停止", message: "退出码 \(proc.terminationStatus)。请重新启动拾燕。日志位于应用数据目录的 logs/desktop-runtime.log。")
            }
        }
        try process.run()
        backend = process
        backendPID = process.processIdentifier
        startedAt = Date()
        readyTimer = Timer.scheduledTimer(withTimeInterval: 0.15, repeats: true) { [weak self] _ in
            self?.checkReady()
        }
    }

    private func checkReady() {
        if backendPID > 0 && getpgid(backendPID) == backendPID { backendGroupOwned = true }
        if let data = try? Data(contentsOf: readyURL),
           let info = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let port = info["port"] as? Int,
           let pid = info["pid"] as? Int,
           pid == Int(backendPID), port > 0, port < 65536 {
            readyTimer?.invalidate()
            self.port = port
            self.baseURL = URL(string: "http://127.0.0.1:\(port)")!
            webView.load(URLRequest(url: self.baseURL!.appendingPathComponent("/").appending(queryItems: [URLQueryItem(name: "native", value: "1")])))
        } else if Date().timeIntervalSince(startedAt) > 60 {
            readyTimer?.invalidate()
            showError("本地服务启动超时", message: "请退出后重试。详细错误保存在应用数据目录的 logs/desktop-runtime.log。")
        }
    }

    @objc private func showWindow() {
        if !startupFinished { startupPanel?.orderFrontRegardless(); NSApp.activate(ignoringOtherApps: true); return }
        if window?.isMiniaturized == true { window?.deminiaturize(nil) }
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    @objc private func newConversation() {
        showWindow()
        if activeVoiceCallID == nil { suspendVoiceSession() }
        webView?.evaluateJavaScript("if(window.shiyan?.newConversation){window.shiyan.newConversation()}else{window.dispatchEvent(new CustomEvent('shiyan-native',{detail:{type:'newSession'}}))}")
    }

    @objc private func openFiles() {
        showWindow()
        webView?.evaluateJavaScript("if(window.workbench){window.workbench.openTool('files')}else{window.shiyan?.openImagePicker?.()}")
    }

    func windowWillClose(_ notification: Notification) { suspendVoiceSession() }
    // Window visibility does not own an active Dots call.
    func windowDidMiniaturize(_ notification: Notification) {
        if activeVoiceCallID == nil { suspendVoiceSession() }
        else { syncVoiceCallPanel() }
    }
    func windowDidDeminiaturize(_ notification: Notification) { voiceCallPanel.hide() }
    func applicationDidHide(_ notification: Notification) {
        if activeVoiceCallID == nil { suspendVoiceSession() }
    }
    func applicationDidUnhide(_ notification: Notification) { syncVoiceCallPanel() }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showWindow()
        return true
    }

    func applicationWillTerminate(_ notification: Notification) {
        quitting = true
        startupPanel?.close()
        browserWorkspace?.closeAll()
        suspendVoiceSession(waitForVoiceExit: true)
        readyTimer?.invalidate()
        webView?.configuration.userContentController.removeScriptMessageHandler(forName: "native")
        if backendPID > 0 {
            let owned = backendGroupOwned || getpgid(backendPID) == backendPID
            if owned { kill(-backendPID, SIGTERM) }
            else if backend?.isRunning == true { backend?.terminate() }
            let deadline = Date().addingTimeInterval(2)
            while Date() < deadline {
                if owned ? kill(-backendPID, 0) != 0 : backend?.isRunning != true { break }
                Thread.sleep(forTimeInterval: 0.05)
            }
            if owned && kill(-backendPID, 0) == 0 { kill(-backendPID, SIGKILL) }
            else if backend?.isRunning == true { kill(backendPID, SIGKILL) }
        }
        try? startupLog?.close()
        if let readyURL = readyURL { try? FileManager.default.removeItem(at: readyURL) }
        if let previews = previewDirectory { try? FileManager.default.removeItem(at: previews) }
        if lockFD >= 0 {
            flock(lockFD, LOCK_UN)
            Darwin.close(lockFD)
        }
    }

    private func localURL(_ raw: String) -> URL? {
        guard let base = baseURL, let url = URL(string: raw, relativeTo: base)?.absoluteURL,
              url.scheme == "http", url.host == "127.0.0.1", url.port == port,
              url.user == nil, url.password == nil else { return nil }
        return url
    }

    private func trustedContentFrameURL(_ raw: String, mainFrame: Bool) -> URL? {
        guard let url = localURL(raw) else { return nil }
        if !mainFrame {
            let path = url.path
            guard (path == "/assets/knowledge-ui" || path.hasPrefix("/assets/knowledge-ui/")),
                  !path.split(separator: "/").contains("..") else { return nil }
        }
        return url
    }

    private func assetURL(_ raw: String) -> URL? {
        guard let url = localURL(raw),
              url.path.range(of: "^/api/assets/[A-Za-z0-9_-]+/file$", options: .regularExpression) != nil else { return nil }
        return url
    }

     
     
    private func syncVoiceCallPanel() {
        guard window?.isMiniaturized == true, let callID = activeVoiceCallID,
              let presentation = voiceCallPresentation, presentation.callID == callID,
              let baseURL = baseURL else { voiceCallPanel.hide(); return }
        voiceCallPanel.update(presentation, baseURL: baseURL)
        voiceCallPanel.show()
    }

    private func updateDotsVoiceCall(_ body: [String: Any]) {
        guard let presentation = VoiceCallPresentation(body),
              presentation.callID == activeVoiceCallID else { return }
        voiceCallPresentation = presentation
        syncVoiceCallPanel()
    }

    private func suspendVoiceSession(waitForVoiceExit: Bool = false) {
        let suspendedCallID = activeVoiceCallID
        activeVoiceCallID = nil
        voiceCallPresentation = nil
        voiceCallPanel.clear()
        speech.cancel()
        voicePlayback.shutdown(waitForExit: waitForVoiceExit)
        messagePlayback.cancel()
        var detail: [String: Any] = ["type": "voiceSessionSuspended"]
        if let suspendedCallID = suspendedCallID { detail["callId"] = suspendedCallID }
        emit(detail)
    }

     
    private func recordVoiceTrace(_ stage: String, _ detail: [String: Any]) {
        guard ProcessInfo.processInfo.environment["SHIYAN_VOICE_DIAGNOSTICS"] == "1" || CommandLine.arguments.contains("--voice-diagnostics") else { return }
        var event: [String: Any] = ["time": Date().timeIntervalSince1970, "stage": stage]
        let strings = ["callId", "recognitionId", "playbackId", "sessionId", "requestId", "phase", "state", "voiceIdentifier"]
        for key in strings {
            if let value = detail[key] as? String, value.count <= 160 { event[key] = value }
        }
        for key in ["messageId", "replyId", "characterCount", "voiceQuality", "errorCode", "rawCharacterCount", "mergedCharacterCount", "segmentCount", "hypothesisRevision", "overlappingSegmentsRemoved"] {
            if let value = detail[key] as? NSNumber { event[key] = value }
        }
        for key in ["hasError", "accepted", "active", "isSpeaking", "onDevice"] {
            if let value = detail[key] as? Bool { event[key] = value }
        }
        if let windows = detail["segmentWindows"] as? [[String: Any]] {
            event["segmentWindows"] = windows.prefix(24).map { window in
                var metadata: [String: Any] = [:]
                for key in ["index", "startMS", "endMS", "characterCount", "confidence"] {
                    if let value = window[key] as? NSNumber { metadata[key] = value }
                }
                return metadata
            }
        }
        guard var data = try? JSONSerialization.data(withJSONObject: event) else { return }
        data.append(0x0A)
        let url = dataDirectory.appendingPathComponent("logs/dots-voice-chain.jsonl")
        if !FileManager.default.fileExists(atPath: url.path) {
            FileManager.default.createFile(atPath: url.path, contents: nil, attributes: [.posixPermissions: 0o600])
        }
        guard let file = try? FileHandle(forWritingTo: url) else { return }
        defer { try? file.close() }
        _ = try? file.seekToEnd(); try? file.write(contentsOf: data)
    }

    private func emit(_ detail: [String: Any]) {
        if !Thread.isMainThread {
            DispatchQueue.main.async { [weak self] in self?.emit(detail) }
            return
        }
        accountGate.deliver { [weak self] in self?.emitAuthorized(detail) }
    }

    private func emitAuthorized(_ detail: [String: Any]) {
        if let type = detail["type"] as? String {
            if ["voicePlaybackState", "voiceSessionSuspended", "speechState", "speechError"].contains(type) {
                recordVoiceTrace(type, detail)
            } else if type == "speech", detail["isFinal"] as? Bool == true {
                var metadata = detail; metadata["characterCount"] = (detail["text"] as? String)?.count ?? 0
                recordVoiceTrace("recognition_final", metadata)
            }
        }
        guard let data = try? JSONSerialization.data(withJSONObject: detail),
              let text = String(data: data, encoding: .utf8) else { return }
        webView?.evaluateJavaScript("window.dispatchEvent(new CustomEvent('shiyan-native',{detail:\(text)}));") { [weak self] _, error in
            if let error = error as NSError? { self?.recordVoiceTrace("bridge_emit_failed", ["errorCode": error.code]) }
        }
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.webView === webView, message.frameInfo.isMainFrame,
              let source = message.frameInfo.request.url,
              localURL(source.absoluteString) != nil,
              let body = message.body as? [String: Any],
              let action = body["action"] as? String else { return }
        let complete: (NativeAccountGate.Permit?) -> Void = { [weak self] permit in
            guard let self = self, let permit = permit else { return }
            self.handleAuthorized(body, action: action, permit: permit)
        }
        let presentationOnly = action == "workbench" && ["menu", "dividers", "show"].contains(body["op"] as? String ?? "")
        let accountActions = ["dotsVoiceTrace", "startSpeech", "stopSpeech", "cancelSpeech", "prepareVoicePlayback", "updateDotsVoiceCall", "endVoiceCall", "speakVoice", "cancelVoicePlayback", "readMessage", "stopMessageReading", "newSession", "share", "save", "preview", "openExternal"]
        if accountActions.contains(action) { accountGate.authorizeUser(complete) }
        else if presentationOnly { accountGate.authorizePresentation(complete) }
        else { accountGate.authorize(complete) }
    }

    private func handleAuthorized(_ body: [String: Any], action: String, permit: NativeAccountGate.Permit) {
        let id = body["id"] as? String ?? UUID().uuidString
        switch action {
        case "dotsVoiceTrace":
            let stages = ["call_started", "call_stopped", "recognition_requested", "voice_submit_requested", "voice_message_accepted", "voice_submit_failed", "voice_reply_matched", "playback_event"]
            if let stage = body["stage"] as? String, stages.contains(stage) { recordVoiceTrace(stage, body) }
        case "startSpeech", "stopSpeech", "cancelSpeech":
            guard let sessionID = body["sessionId"] as? String,
                  UUID(uuidString: sessionID) != nil else { return }
            // Ordinary dictation has no callId. A Dots request must belong to
            // the live call, so queued old requests cannot reopen the mic.
            if let callID = body["callId"] as? String, callID != activeVoiceCallID { return }
            if action == "startSpeech" {
                let silence = (body["autoStopAfterSilence"] as? NSNumber)?.doubleValue
                messagePlayback.cancel()
                speech.start(sessionID: sessionID, autoStopAfterSilence: silence)
            }
            else if action == "stopSpeech" { speech.stop(sessionID: sessionID) }
            else { speech.cancel(sessionID: sessionID) }
        case "prepareVoicePlayback":
            guard let callID = body["callId"] as? String,
                  UUID(uuidString: callID) != nil else { return }
            if activeVoiceCallID != nil && activeVoiceCallID != callID {
                speech.cancel()
                voicePlayback.shutdown()
            }
            if activeVoiceCallID != callID {
                voiceCallPresentation = nil
                voiceCallPanel.clear()
            }
            activeVoiceCallID = callID
            voicePlayback.prepare()
        case "updateDotsVoiceCall":
            updateDotsVoiceCall(body)
        case "endVoiceCall":
            guard let callID = body["callId"] as? String,
                  callID == activeVoiceCallID else { return }
            activeVoiceCallID = nil
            voiceCallPresentation = nil
            voiceCallPanel.clear()
            speech.cancel()
            voicePlayback.shutdown()
        case "speakVoice", "cancelVoicePlayback":
            guard let sessionID = body["sessionId"] as? String,
                  UUID(uuidString: sessionID) != nil else { return }
            if let callID = body["callId"] as? String, callID != activeVoiceCallID { return }
            if action == "speakVoice" {
                guard let callID = body["callId"] as? String,
                      callID == activeVoiceCallID else { return }
                guard let text = body["text"] as? String, text.utf8.count <= 100000,
                      text.count <= 20000 else { return }
                recordVoiceTrace("tts_requested", ["sessionId": sessionID, "characterCount": text.count])
                speech.cancel()
                messagePlayback.cancel()
                voicePlayback.speak(text, sessionID: sessionID)
            } else { voicePlayback.cancel(sessionID: sessionID) }
        case "readMessage", "stopMessageReading":
            guard let sessionID = body["sessionId"] as? String,
                  UUID(uuidString: sessionID) != nil else { return }
            if action == "readMessage" {
                guard let text = body["text"] as? String, text.utf8.count <= 100000,
                      text.count <= 20000 else { return }
                messagePlayback.speak(text, sessionID: sessionID)
            } else { messagePlayback.cancel(sessionID: sessionID) }
        case "workbench": browserWorkspace?.handle(body)
        case "newSession": newConversation()
        case "share":
            shareAssets(body["assets"] as? [[String: Any]] ?? [], id: id, permit: permit)
        case "save", "preview":
            guard let raw = body["url"] as? String, let url = assetURL(raw) else {
                emit(["type": "nativeError", "id": id, "message": "文件地址无效。"])
                return
            }
            let name = (body["suggestedName"] as? String) ?? (body["filename"] as? String) ?? "拾燕附件"
            if action == "save" { saveAsset(url, filename: name, id: id, permit: permit) }
            else { previewAsset(url, filename: name, id: id, permit: permit) }
        case "reveal":
            if let url = savedFiles[id] {
                NSWorkspace.shared.activateFileViewerSelecting([url])
            } else if let raw = body["path"] as? String {
                let url = URL(fileURLWithPath: raw).resolvingSymlinksInPath()
                let root = dataDirectory.resolvingSymlinksInPath().path + "/"
                if url.path.hasPrefix(root), FileManager.default.fileExists(atPath: url.path) {
                    NSWorkspace.shared.activateFileViewerSelecting([url])
                }
            }
        case "openExternal":
            if let raw = body["url"] as? String, let url = URL(string: raw),
               ["https", "http"].contains(url.scheme ?? ""), url.host != nil {
                NSWorkspace.shared.open(url)
            }
        default: break
        }
    }

    private func safeName(_ original: String) -> String {
        let name = (original as NSString).lastPathComponent
            .replacingOccurrences(of: ":", with: "-")
        return name.isEmpty || name == "." || name == ".." ? "拾燕附件" : String(name.prefix(180))
    }

    private func saveAsset(_ url: URL, filename: String, id: String, permit: NativeAccountGate.Permit) {
        let panel = NSSavePanel()
        panel.title = "保存附件"
        panel.nameFieldStringValue = safeName(filename)
        panel.canCreateDirectories = true
        panel.beginSheetModal(for: window) { [weak self] response in
            guard let self = self else { return }
            guard response == .OK, let destination = panel.url else {
                self.emit(["type": "saveCancelled", "id": id]); return
            }
            self.fetchAsset(url, destination: destination, id: id, permit: permit) { saved in
                guard let saved = saved else { return }
                self.savedFiles[id] = saved
                self.emit(["type": "saved", "id": id, "path": saved.path])
            }
        }
    }

    private func previewAsset(_ url: URL, filename: String, id: String, permit: NativeAccountGate.Permit) {
        let destination = previewDirectory.appendingPathComponent(UUID().uuidString + "-" + safeName(filename))
        fetchAsset(url, destination: destination, id: id, permit: permit) { [weak self] saved in
            guard let self = self, let saved = saved else { return }
            self.previewURL = saved
            if let panel = QLPreviewPanel.shared() {
                panel.dataSource = self
                panel.delegate = self
                panel.reloadData()
                panel.makeKeyAndOrderFront(nil)
            }
            self.emit(["type": "previewReady", "id": id])
        }
    }

    private func fetchAsset(_ url: URL, destination: URL, id: String, permit: NativeAccountGate.Permit, completion: @escaping (URL?) -> Void) {
        accountGate.revalidate(permit) { [weak self] allowed in
            guard let self = self, allowed else { completion(nil); return }
            let key = UUID()
            self.nativeTransfers[key] = self.accountGate.fetch(self.accountGate.request(url, permit: permit)) { [weak self] data, response, error in
                guard let self = self else { completion(nil); return }
                self.nativeTransfers.removeValue(forKey: key)
                self.accountGate.revalidate(permit) { allowed in
                    guard allowed else { completion(nil); return }
                    do {
                        guard error == nil, let data = data, data.count <= 40 * 1024 * 1024,
                              let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode),
                              let finalURL = http.url, self.assetURL(finalURL.absoluteString) != nil else {
                            throw NSError(domain: "ShiYan", code: 4, userInfo: [NSLocalizedDescriptionKey: "文件下载失败，请重试。"])
                        }
                        try data.write(to: destination, options: .atomic)
                        completion(destination)
                    } catch {
                        self.emit(["type": "nativeError", "id": id, "message": error.localizedDescription]); completion(nil)
                    }
                }
            }
        }
    }

    private func shareAssets(_ items: [[String: Any]], id: String, permit: NativeAccountGate.Permit) {
        let selected = Array(items.prefix(20))
        guard !selected.isEmpty else { return }
        let group = DispatchGroup()
        var files: [URL] = []
        for item in selected {
            guard let raw = item["url"] as? String, let url = assetURL(raw) else { continue }
            let name = safeName(item["filename"] as? String ?? "拾燕附件")
            let destination = previewDirectory.appendingPathComponent(UUID().uuidString + "-" + name)
            group.enter()
            fetchAsset(url, destination: destination, id: id, permit: permit) { saved in
                if let saved = saved { files.append(saved) }; group.leave()
            }
        }
        group.notify(queue: .main) { [weak self] in
            guard let self = self else { return }
            self.accountGate.revalidate(permit) { allowed in
                guard allowed, !files.isEmpty, files.count == selected.count else { return }
                self.sharingPicker = NSSharingServicePicker(items: files)
                self.sharingPicker?.show(relativeTo: NSRect(x: self.webView.bounds.midX, y: self.webView.bounds.midY, width: 1, height: 1),
                                         of: self.webView, preferredEdge: .minY)
                self.emit(["type": "shareReady", "id": id, "count": files.count])
            }
        }
    }

    func numberOfPreviewItems(in panel: QLPreviewPanel!) -> Int { previewURL == nil ? 0 : 1 }
    func previewPanel(_ panel: QLPreviewPanel!, previewItemAt index: Int) -> QLPreviewItem! {
        previewURL as NSURL?
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        guard let url = frame.request.url,
              trustedContentFrameURL(url.absoluteString, mainFrame: frame.isMainFrame) != nil else {
            completionHandler(false); return
        }
        accountGate.authorizeUser { [weak self] permit in
            guard let self = self, let permit = permit, let window = self.window else {
                completionHandler(false); return
            }
            let alert = NSAlert()
            alert.messageText = message
            alert.alertStyle = .warning
            alert.addButton(withTitle: "确定")
            alert.addButton(withTitle: "取消")
            alert.beginSheetModal(for: window) { response in
                self.accountGate.revalidate(permit) { allowed in
                    completionHandler(allowed && response == .alertFirstButtonReturn)
                }
            }
        }
    }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        guard let url = frame.request.url,
              trustedContentFrameURL(url.absoluteString, mainFrame: frame.isMainFrame) != nil else {
            completionHandler(nil); return
        }
        accountGate.authorizeUser { [weak self] permit in
            guard let self = self, let permit = permit else { completionHandler(nil); return }
            let panel = NSOpenPanel()
            panel.canChooseDirectories = parameters.allowsDirectories
            panel.canChooseFiles = true
            panel.allowsMultipleSelection = parameters.allowsMultipleSelection
            panel.beginSheetModal(for: self.window) { response in
                self.accountGate.revalidate(permit) { allowed in
                    completionHandler(allowed && response == .OK ? panel.urls : nil)
                }
            }
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
        if url.absoluteString == "about:blank" { decisionHandler(.allow); return }
        if localURL(url.absoluteString) != nil {
            if navigationAction.shouldPerformDownload { decisionHandler(.download) }
            else { decisionHandler(.allow) }
            return
        }
        if navigationAction.targetFrame?.isMainFrame != false {
            if ["https", "http"].contains(url.scheme ?? "") { emit(["type":"browserNewTab","url":url.absoluteString]) }
            else if url.scheme == "mailto" { accountGate.authorizeUser { permit in if permit != nil { NSWorkspace.shared.open(url) } } }
        }
        decisionHandler(.cancel)
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        guard let url = navigationResponse.response.url, localURL(url.absoluteString) != nil else {
            decisionHandler(.cancel); return
        }
        if !navigationResponse.canShowMIMEType { decisionHandler(.download) }
        else { decisionHandler(.allow) }
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url {
            if localURL(url.absoluteString) != nil { webView.load(URLRequest(url: url)) }
            else if ["https", "http"].contains(url.scheme ?? "") { emit(["type":"browserNewTab","url":url.absoluteString]) }
            else if url.scheme == "mailto" { accountGate.authorizeUser { permit in if permit != nil { NSWorkspace.shared.open(url) } } }
        }
        return nil
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        track(download)
    }
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        track(download)
    }
    private func track(_ download: WKDownload) {
        activeDownloads[ObjectIdentifier(download)] = download
        download.delegate = self
    }

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse,
                  suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        guard let url = response.url, assetURL(url.absoluteString) != nil else {
            completionHandler(nil); return
        }
        accountGate.authorizeUser { [weak self] permit in
            guard let self = self, let permit = permit else { completionHandler(nil); return }
            let panel = NSSavePanel()
            panel.nameFieldStringValue = self.safeName(suggestedFilename)
            panel.canCreateDirectories = true
            panel.beginSheetModal(for: self.window) { response in
                self.accountGate.revalidate(permit) { allowed in
                    completionHandler(allowed && response == .OK ? panel.url : nil)
                }
            }
        }
    }
    func downloadDidFinish(_ download: WKDownload) {
        activeDownloads.removeValue(forKey: ObjectIdentifier(download))
        emit(["type": "downloadFinished"])
    }
    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        activeDownloads.removeValue(forKey: ObjectIdentifier(download))
        if (error as NSError).code != NSURLErrorCancelled {
            emit(["type": "nativeError", "message": error.localizedDescription])
        }
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) { suspendVoiceSession() }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        if !startupFinished {
            if let url = webView.url, localURL(url.absoluteString) != nil { waitForWorkbench() }
            return
        }
        if CommandLine.arguments.contains("--self-test-workbench"), let url = webView.url, localURL(url.absoluteString) != nil {
            if !workbenchTestStarted { workbenchTestStarted = true; runWorkbenchSelfTest(attempt: 0) }
            return
        }
        guard CommandLine.arguments.contains("--self-test"), !selfTestWritten,
              let url = webView.url, localURL(url.absoluteString) != nil else { return }
        selfTestWritten = true
        recordSelfTestStage("navigationLoaded")
        waitForSelfTestImages(webView, attempts: 0)
    }

    private func recordSelfTestStage(_ stage: String) {
        guard CommandLine.arguments.contains("--self-test") else { return }
        try? (stage + "\n").write(to: dataDirectory.appendingPathComponent("native-self-test-stage.txt"), atomically: true, encoding: .utf8)
    }

    private func waitForSelfTestImages(_ webView: WKWebView, attempts: Int) {
        let script = """
        (() => {
          const visible = Array.from(document.images).filter(i => {
            const r = i.getBoundingClientRect();
            if (!i.getClientRects().length || r.width <= 0 || r.height <= 0) return false;
            for (let n=i; n; n=n.parentElement) {
              const s=getComputedStyle(n);
              if (n.hidden || s.display==='none' || s.visibility==='hidden' || +s.opacity===0) return false;
            }
            return true;
          });
          return {ready:visible.length>0 && visible.every(i=>i.complete&&i.naturalWidth>0), count:visible.length};
        })()
        """
        recordSelfTestStage("checkingVisibleImages-\(attempts)")
        webView.evaluateJavaScript(script) { [weak self] value, error in
            guard let self = self else { return }
            let ready = (value as? [String: Any])?["ready"] as? Bool ?? false
            if ready || attempts >= 24 || error != nil {
                self.recordSelfTestStage(ready ? "visibleImagesLoaded" : "imageWaitBoundReached")
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { self.captureSelfTest(webView) }
            } else {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { self.waitForSelfTestImages(webView, attempts: attempts + 1) }
            }
        }
    }

    private func captureSelfTest(_ webView: WKWebView) {
        recordSelfTestStage("capturingWindow")
        webView.takeSnapshot(with: nil) { [weak self] image, _ in
            guard let self = self, let tiff = image?.tiffRepresentation,
                  let bitmap = NSBitmapImageRep(data: tiff),
                  let png = bitmap.representation(using: .png, properties: [:]) else { return }
            try? png.write(to: self.dataDirectory.appendingPathComponent("native-window-content.png"), options: .atomic)
        }
        webView.evaluateJavaScript("({title:document.title,native:window.__SHIYAN_NATIVE__===true,url:location.href,body:!!document.body,images:Array.from(document.images).filter(i=>i.getBoundingClientRect().width>0).map(i=>({src:new URL(i.currentSrc||i.src).pathname,loaded:i.complete&&i.naturalWidth>0}))})") { [weak self] result, error in
            guard let self = self else { return }
            self.window.performClose(nil)
            let closePassed = !self.window.isVisible
            self.showWindow()
            let reopenPassed = self.window.isVisible
            var report: [String: Any] = [
                "windowClosePassed": closePassed, "windowReopenPassed": reopenPassed,
                "assetURLBoundaryPassed": self.assetURL("https://example.invalid/api/assets/uuid/file") == nil && self.assetURL("file:///etc/passwd") == nil && self.assetURL("/api/assets/12345678-1234-1234-1234-123456789012/file") != nil,
                "appPath": Bundle.main.bundlePath, "backendPID": Int(self.backendPID),
                "backendPort": self.port, "nativeWindow": self.window != nil,
                "windowWidth": self.window.frame.width, "windowHeight": self.window.frame.height,
                "backendOwnProcessGroup": self.backendGroupOwned,
                "page": result ?? NSNull(), "javascriptError": error?.localizedDescription ?? ""
            ]
            report["testedAt"] = ISO8601DateFormatter().string(from: Date())
            if let data = try? JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]) {
                try? data.write(to: self.dataDirectory.appendingPathComponent("native-self-test.json"), options: .atomic)
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 3) { NSApp.terminate(nil) }
        }
    }

    private func runWorkbenchSelfTest(attempt: Int) {
        webView.evaluateJavaScript("window.workbench?.ready ? window.workbench.getLayout() : null") { [weak self] value, error in
            guard let self = self else { return }
            guard let layout = value as? [String: Any], let tabID = layout["activeTab"] as? String,
                  let raw = ProcessInfo.processInfo.environment["SHIYAN_BROWSER_TEST_URL"], let url = URL(string: raw) else {
                if attempt < 100 {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { self.runWorkbenchSelfTest(attempt: attempt + 1) }
                } else {
                    self.showError("工作台测试未就绪", message: error?.localizedDescription ?? "workbench.ready timed out")
                }
                return
            }
            self.browserWorkspace?.selfTest(url: url, tabID: tabID) { result in
                self.checkNativeDividerRoundTrip { dividerResult in
                var report = result
                report.merge(dividerResult, uniquingKeysWith: { _, new in new })
                report["layout"] = layout
                report["backendPID"] = self.backendPID
                report["testedAt"] = ISO8601DateFormatter().string(from: Date())
                report["appInternalOriginRejected"] = self.baseURL.map { self.browserWorkspace?.rejectsURL($0) == true } ?? false
                if let data = try? JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]) {
                    try? data.write(to: self.dataDirectory.appendingPathComponent("native-workbench-test.json"), options: .atomic)
                }
                self.webView.takeSnapshot(with: nil) { image, _ in
                    if let tiff = image?.tiffRepresentation, let bitmap = NSBitmapImageRep(data: tiff),
                       let data = bitmap.representation(using: .png, properties: [:]) {
                        try? data.write(to: self.dataDirectory.appendingPathComponent("native-workbench-ui.png"), options: .atomic)
                    }
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1) { NSApp.terminate(nil) }
                }
                }
            }
        }
    }

    private func checkNativeDividerRoundTrip(completion: @escaping ([String: Any]) -> Void) {
        let script = "window.workbench.getLayout().rects"
        webView.evaluateJavaScript(script) { [weak self] value, _ in
            guard let self = self, let before = value as? [String:[String:Double]],
                  let rightBefore = before["rightWorkspace"]?["width"], let centerBefore = before["mainWorkspace"]?["width"] else {
                completion(["nativeDividerRoundTrip":false]); return
            }
            var checks = self.browserWorkspace?.exerciseDividerForTest(delta:-60) ?? [:]
            DispatchQueue.main.asyncAfter(deadline:.now()+0.4) {
                self.webView.evaluateJavaScript(script) { value, _ in
                    let after = value as? [String:[String:Double]]
                    checks["nativeDividerRoundTrip"] = (after?["rightWorkspace"]?["width"] ?? 0) > rightBefore + 50
                    checks["nativeDividerUpdatesCenter"] = (after?["mainWorkspace"]?["width"] ?? centerBefore) < centerBefore - 50
                    _ = self.browserWorkspace?.exerciseDividerForTest(delta:60)
                    DispatchQueue.main.asyncAfter(deadline:.now()+0.4) {
                        self.webView.evaluateJavaScript(script) { value, _ in
                            let restored = value as? [String:[String:Double]]
                            checks["nativeDividerRestoresWidth"] = abs((restored?["rightWorkspace"]?["width"] ?? 0)-rightBefore) < 2
                            completion(checks)
                        }
                    }
                }
            }
        }
    }

    private func showError(_ title: String, message: String) {
        if !startupFinished { finishStartup() }
        if CommandLine.arguments.contains(where: { $0.hasPrefix("--self-test") }) {
            let report: [String: Any] = ["error": title, "message": message, "backendPID": Int(backendPID)]
            if let data = try? JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted]) {
                try? data.write(to: dataDirectory.appendingPathComponent("native-self-test.json"), options: .atomic)
            }
            NSApp.terminate(nil)
            return
        }
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = message
        alert.addButton(withTitle: "好")
        if let window = window { alert.beginSheetModal(for: window) }
        else { alert.runModal() }
    }
}

@main
enum ShiYanDesktopMain {
    static func main() {
        let application = NSApplication.shared
        let delegate = AppDelegate()
        application.setActivationPolicy(.regular)
        application.delegate = delegate
        withExtendedLifetime(delegate) { application.run() }
    }
}
