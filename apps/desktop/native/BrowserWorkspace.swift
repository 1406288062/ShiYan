import AppKit
import WebKit
import Foundation

 
 
final class BrowserWorkspace: NSObject, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
    private weak var host: NSView?
    private weak var window: NSWindow?
    private let send: ([String: Any]) -> Void
    private let isInternal: (URL) -> Bool
    private let authorize: (@escaping (Bool) -> Void) -> Void
    private var accountGeneration = UUID()
    private let stateURL: URL
    private let dataStore: WKWebsiteDataStore
    private var views: [String: WKWebView] = [:]
    private var observations: [String: [NSKeyValueObservation]] = [:]
    private var downloads: [ObjectIdentifier: WKDownload] = [:]
    private var destinations: [ObjectIdentifier: (String, URL, URL)] = [:]
    private var history: [[String: Any]] = []
    private var bookmarks: [[String: Any]] = []
    private var downloadRecords: [[String: Any]] = []
    private var searchEngine = "bing"
    private var active: String?
    private var desiredVisible = false
    private var rect = NSRect.zero
    private var errors: [String: String] = [:]
    private var testTimer: Timer?
    private var chrome: WorkspaceChrome?
    private var testDownloadTarget: URL?
    private var testDownloadSource: URL?

    init(host: NSView, window: NSWindow, directory: URL,
         isInternal: @escaping (URL) -> Bool, emit: @escaping ([String: Any]) -> Void,
         authorize: @escaping (@escaping (Bool) -> Void) -> Void = { $0(false) }) {
        self.host = host
        self.window = window
        self.send = emit
        self.isInternal = isInternal
        self.authorize = authorize
        self.stateURL = directory.appendingPathComponent("browser-workspace-v1.json")
        self.dataStore = CommandLine.arguments.contains("--self-test-workbench") ? .nonPersistent() : .default()
        super.init()
        chrome = WorkspaceChrome(host: host, emit: emit)
        if let data = try? Data(contentsOf: stateURL),
           let state = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] {
            history = state["history"] as? [[String: Any]] ?? []
            bookmarks = state["bookmarks"] as? [[String: Any]] ?? []
            downloadRecords = state["downloads"] as? [[String: Any]] ?? []
            searchEngine = state["searchEngine"] as? String ?? "bing"
            for i in downloadRecords.indices where downloadRecords[i]["status"] as? String == "downloading" {
                downloadRecords[i]["status"] = "interrupted"
            }
        }
    }

    private func identifier(for view: WKWebView) -> String? {
        views.first(where: { $0.value === view })?.key
    }

    private func persist() {
        let value: [String: Any] = ["history": Array(history.prefix(2000)), "bookmarks": bookmarks,
                                  "downloads": Array(downloadRecords.prefix(200)), "searchEngine": searchEngine]
        if let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) {
            try? data.write(to: stateURL, options: .atomic)
            try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: stateURL.path)
        }
    }

    func snapshot() -> [String: Any] {
        var tabs: [[String: Any]] = views.map { id, view in
            ["id": id, "url": view.url?.absoluteString ?? "", "title": view.title ?? "网页",
             "loading": view.isLoading, "canBack": view.canGoBack, "canForward": view.canGoForward,
             "progress": view.estimatedProgress, "error": errors[id] ?? ""]
        }
        for (id, message) in errors where views[id] == nil {
            tabs.append(["id":id,"url":"","title":"无法打开","loading":false,"canBack":false,"canForward":false,"error":message])
        }
        return ["type": "browserState", "tabs": tabs, "history": Array(history.prefix(2000)),
                "bookmarks": bookmarks, "downloads": Array(downloadRecords.prefix(200)),
                "searchEngine": searchEngine, "nativeBrowser": true]
    }

    private func notify() { send(snapshot()) }

    private func create(_ id: String) -> WKWebView? {
        if let existing = views[id] { return existing }
        guard UUID(uuidString: id) != nil, views.count < 16, let host = host else { return nil }
        let config = WKWebViewConfiguration()
        config.websiteDataStore = dataStore
        config.preferences.javaScriptCanOpenWindowsAutomatically = false
         
        config.userContentController = WKUserContentController()
        let view = WKWebView(frame: rect, configuration: config)
        // Bare WKWebView omits Safari's browser tokens; some sites return an empty fallback page.
        view.customUserAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15"
        view.navigationDelegate = self
        view.uiDelegate = self
        view.allowsBackForwardNavigationGestures = true
        if #available(macOS 13.3, *) { view.isInspectable = false }
        view.isHidden = true
        host.addSubview(view)
        chrome?.bringToFront()
        views[id] = view
        observations[id] = [
            view.observe(\.isLoading, options: [.new]) { [weak self] _, _ in self?.notify() },
            view.observe(\.canGoBack, options: [.new]) { [weak self] _, _ in self?.notify() },
            view.observe(\.canGoForward, options: [.new]) { [weak self] _, _ in self?.notify() },
            view.observe(\.title, options: [.new]) { [weak self] _, _ in self?.notify() }
        ]
        return view
    }

    private func validURL(_ raw: String) -> URL? {
        guard raw.count <= 8192, let url = URL(string: raw),
              ["https", "http"].contains(url.scheme?.lowercased() ?? ""),
              url.host != nil, url.user == nil, url.password == nil, !isInternal(url) else { return nil }
        return url
    }

    private func applyVisibility() {
        chrome?.bringToFront()
        for (id, view) in views {
            if view.frame != rect { view.frame = rect }
            let hidden = !desiredVisible || id != active || !(errors[id] ?? "").isEmpty || rect.width < 20 || rect.height < 20
            if view.isHidden != hidden { view.isHidden = hidden }
        }
    }

    func handle(_ body: [String: Any]) {
        let op = body["op"] as? String ?? ""
        let id = body["tabId"] as? String ?? ""
        switch op {
        case "menu": chrome?.presentMenu(body)
        case "dividers": chrome?.updateDividers(body)
        case "state": notify()
        case "show":
            guard let host = host else { return }
            desiredVisible = body["visible"] as? Bool ?? false
            active = id
            if let value = body["rect"] as? [String: Double],
               let x = value["x"], let y = value["y"], let w = value["width"], let h = value["height"],
               [x, y, w, h].allSatisfy({ $0.isFinite }) {
                let bounds = host.bounds
                let px = CGFloat(x), py = CGFloat(y), pw = CGFloat(w), ph = CGFloat(h)
                rect = NSRect(x: max(0, px), y: max(0, bounds.height - py - ph),
                              width: max(0, min(pw, bounds.width - max(0, px))),
                              height: max(0, min(ph, bounds.height - max(0, py))))
            }
            applyVisibility()
        case "navigate":
            guard let raw = body["url"] as? String, let url = validURL(raw), let view = create(id) else {
                errors[id] = "无法打开该地址。仅支持网页地址，应用内部服务不能在浏览器中访问。"
                notify(); applyVisibility(); return
            }
            errors[id] = nil
            view.load(URLRequest(url: url))
            applyVisibility()
        case "back": errors[id] = nil; views[id]?.goBack(); applyVisibility()
        case "forward": errors[id] = nil; views[id]?.goForward(); applyVisibility()
        case "reload":
            errors[id] = nil
            if let view = views[id], view.url != nil { view.reload() }
            else if let raw = body["url"] as? String, let url = validURL(raw) { create(id)?.load(URLRequest(url: url)) }
            applyVisibility()
        case "stop": views[id]?.stopLoading()
        case "close":
            views[id]?.stopLoading(); views[id]?.removeFromSuperview()
            observations.removeValue(forKey: id); views.removeValue(forKey: id); errors.removeValue(forKey: id)
            notify()
        case "bookmark":
            guard let raw = body["url"] as? String, validURL(raw) != nil else { return }
            if let index = bookmarks.firstIndex(where: { $0["url"] as? String == raw }) { bookmarks.remove(at: index) }
            else { bookmarks.insert(["url": raw, "title": body["title"] as? String ?? raw, "at": ISO8601DateFormatter().string(from: Date())], at: 0) }
            persist(); notify()
        case "clearHistory": history.removeAll(); persist(); notify()
        case "clearDownloads": downloadRecords.removeAll(where: { $0["status"] as? String != "downloading" }); persist(); notify()
        case "searchEngine":
            if let engine = body["value"] as? String, ["bing", "baidu", "duckduckgo"].contains(engine) {
                searchEngine = engine; persist(); notify()
            }
        case "clearWebsiteData":
            dataStore.removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast) { [weak self] in
                self?.send(["type": "workbenchNotice", "message": "浏览器 Cookie 和缓存已清除"])
            }
        case "revealDownload":
            guard let key = body["downloadId"] as? String,
                  let record = downloadRecords.first(where: { $0["id"] as? String == key }),
                  record["status"] as? String == "completed", let path = record["path"] as? String,
                  FileManager.default.fileExists(atPath: path) else { return }
            NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)])
        case "chooseDirectory", "chooseFile":
            guard let window = window else { return }
            desiredVisible = false; applyVisibility()
            let panel = NSOpenPanel()
            panel.canChooseDirectories = op == "chooseDirectory"
            panel.canChooseFiles = op == "chooseFile"
            panel.allowsMultipleSelection = false
            panel.canCreateDirectories = op == "chooseDirectory"
            panel.title = op == "chooseDirectory" ? "选择项目目录" : "打开文件"
            if let raw = body["path"] as? String { panel.directoryURL = URL(fileURLWithPath: raw) }
            let requestID = body["id"] as? String ?? ""
            let generation = accountGeneration
            panel.beginSheetModal(for: window) { [weak self] response in
                guard let self = self else { return }
                self.authorize { allowed in
                    guard allowed, generation == self.accountGeneration else { return }
                    self.send(["type": "workspacePicked", "id": requestID, "cancelled": response != .OK,
                               "path": response == .OK ? (panel.url?.path ?? "") : ""])
                }
            }
        default: break
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
        if url.absoluteString == "about:blank" { decisionHandler(.allow); return }
        guard validURL(url.absoluteString) != nil else {
            if let id = identifier(for: webView), navigationAction.targetFrame?.isMainFrame != false {
                errors[id] = "该地址不允许在浏览器工作区中打开"; notify(); applyVisibility()
            }
            decisionHandler(.cancel); return
        }
        decisionHandler(navigationAction.shouldPerformDownload ? .download : .allow)
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        guard let url = navigationResponse.response.url, validURL(url.absoluteString) != nil else {
            decisionHandler(.cancel); return
        }
        decisionHandler(navigationResponse.canShowMIMEType ? .allow : .download)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url, validURL(url.absoluteString) != nil {
            send(["type": "browserNewTab", "url": url.absoluteString])
        }
        return nil
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard let id = identifier(for: webView) else { return }
        errors[id] = nil
        if let url = webView.url, validURL(url.absoluteString) != nil {
            let raw = url.absoluteString
            if history.first?["url"] as? String != raw {
                history.insert(["url": raw, "title": webView.title ?? raw,
                                "at": ISO8601DateFormatter().string(from: Date())], at: 0)
                if history.count > 2000 { history.removeLast(history.count - 2000) }
                persist()
            }
        }
        notify(); applyVisibility()
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        failed(webView, error)
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { failed(webView, error) }
    private func failed(_ view: WKWebView, _ error: Error) {
        let failure = error as NSError
         
         
        guard failure.code != NSURLErrorCancelled,
              !(failure.domain == "WebKitErrorDomain" && failure.code == 102),
              let id = identifier(for: view) else { return }
        errors[id] = error.localizedDescription; notify(); applyVisibility()
    }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        if let id = identifier(for: webView) { errors[id] = "网页进程已退出，可点击刷新重试"; notify(); applyVisibility() }
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        guard let window = window else { completionHandler(); return }
        let alert = NSAlert(); alert.messageText = frame.request.url?.host ?? "网页提示"
        alert.informativeText = String(message.prefix(2000)); alert.addButton(withTitle: "好")
        alert.beginSheetModal(for: window) { _ in completionHandler() }
    }
    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        guard let window = window else { completionHandler(false); return }
        let alert = NSAlert(); alert.messageText = frame.request.url?.host ?? "网页确认"
        alert.informativeText = String(message.prefix(2000)); alert.addButton(withTitle: "确定"); alert.addButton(withTitle: "取消")
        alert.beginSheetModal(for: window) { completionHandler($0 == .alertFirstButtonReturn) }
    }
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        guard let window = window, let url = frame.request.url, validURL(url.absoluteString) != nil else {
            completionHandler(nil); return
        }
        let generation = accountGeneration
        authorize { [weak self] allowed in
            guard let self = self, allowed, generation == self.accountGeneration else { completionHandler(nil); return }
            let panel = NSOpenPanel(); panel.title = "向 \(url.host ?? "网站") 选择上传文件"
            panel.canChooseDirectories = parameters.allowsDirectories; panel.canChooseFiles = true
            panel.allowsMultipleSelection = parameters.allowsMultipleSelection
            panel.beginSheetModal(for: window) { response in
                self.authorize { allowed in
                    completionHandler(allowed && generation == self.accountGeneration && response == .OK ? panel.urls : nil)
                }
            }
        }
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { track(download) }
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { track(download) }
    private func track(_ download: WKDownload) { downloads[ObjectIdentifier(download)] = download; download.delegate = self }
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse,
                  suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        guard let window = window, let url = response.url, validURL(url.absoluteString) != nil else { completionHandler(nil); return }
        let generation = accountGeneration
        authorize { [weak self] allowed in
            guard let self = self, allowed, generation == self.accountGeneration else { completionHandler(nil); return }
            let panel = NSSavePanel(); panel.title = "保存浏览器下载"
            let name = (suggestedFilename as NSString).lastPathComponent.replacingOccurrences(of: ":", with: "-")
            panel.nameFieldStringValue = name.isEmpty ? "下载文件" : name
            panel.canCreateDirectories = true
            panel.beginSheetModal(for: window) { [weak self] reply in
                guard let self = self, reply == .OK, let target = panel.url else { completionHandler(nil); return }
                self.authorize { allowed in
                    guard allowed, generation == self.accountGeneration else { completionHandler(nil); return }
                    self.prepareDownload(download, source: url, target: target, completion: completionHandler)
                }
            }
        }
    }
    private func prepareDownload(_ download: WKDownload, source: URL, target: URL, completion: (URL?) -> Void) {
        let id = UUID().uuidString
        let staging = target.deletingLastPathComponent().appendingPathComponent(".shiyan-\(id).download")
        destinations[ObjectIdentifier(download)] = (id, staging, target)
        downloadRecords.insert(["id": id, "name": target.lastPathComponent, "path": target.path,
                               "url": source.absoluteString, "status": "downloading", "at": ISO8601DateFormatter().string(from: Date())], at: 0)
        persist(); notify(); completion(staging)
    }

    func downloadDidFinish(_ download: WKDownload) {
        let generation = accountGeneration
        authorize { [weak self] allowed in
            guard let self = self, allowed, generation == self.accountGeneration else { return }
            self.finishAuthorizedDownload(download)
        }
    }
    private func finishAuthorizedDownload(_ download: WKDownload) {
        let key = ObjectIdentifier(download)
        if let (id, staging, destination) = destinations.removeValue(forKey: key) {
            do {
                if FileManager.default.fileExists(atPath: destination.path) {
                    _ = try FileManager.default.replaceItemAt(destination, withItemAt: staging)
                } else { try FileManager.default.moveItem(at: staging, to: destination) }
                updateDownload(id, status: "completed")
            } catch { updateDownload(id, status: "failed"); try? FileManager.default.removeItem(at: staging) }
        }
        downloads.removeValue(forKey: key); persist(); notify()
    }
    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        let key = ObjectIdentifier(download)
        if let (id, staging, _) = destinations.removeValue(forKey: key) {
            try? FileManager.default.removeItem(at: staging); updateDownload(id, status: "failed")
        }
        downloads.removeValue(forKey: key); persist(); notify()
    }
    private func updateDownload(_ id: String, status: String) {
        if let index = downloadRecords.firstIndex(where: { $0["id"] as? String == id }) { downloadRecords[index]["status"] = status }
    }

    func exerciseDividerForTest(delta: CGFloat) -> [String: Any] { chrome?.simulateRightDividerForTest(delta: delta) ?? [:] }

    func rejectsURL(_ url: URL) -> Bool { validURL(url.absoluteString) == nil }

    func closeAll() {
        accountGeneration = UUID()
        chrome?.close()
        testTimer?.invalidate()
        for view in views.values { view.stopLoading(); view.removeFromSuperview() }
        observations.removeAll(); views.removeAll()
        for download in downloads.values { download.cancel { _ in } }
        downloads.removeAll()
        for (_, staging, _) in destinations.values { try? FileManager.default.removeItem(at: staging) }
        destinations.removeAll()
        active = nil; desiredVisible = false
    }

     
     
    func selfTest(url: URL, tabID: String, completion: @escaping ([String: Any]) -> Void) {
        guard CommandLine.arguments.contains("--self-test-workbench") else { return }
        let id = tabID
        guard let view = create(id) else { completion(["error": "test browser allocation failed"]); return }
        active = id; desiredVisible = true
        if let host = host { rect = NSRect(x: max(0, host.bounds.width - 440), y: 0, width: min(440, host.bounds.width), height: max(100, host.bounds.height - 96)) }
        applyVisibility()
        var result: [String: Any] = ["separateWebView": true, "appScriptsNotInjected": view.configuration.userContentController.userScripts.isEmpty]
        result.merge(chrome?.selfTest() ?? [:], uniquingKeysWith: { _, new in new })
        view.load(URLRequest(url: url))
        waitUntil({ !view.isLoading && view.title == "ShiYan Browser Fixture" }, timeout: 12) { [weak self] first in
            guard let self = self else { return }
            result["httpPageLoaded"] = first
            view.evaluateJavaScript("({noNative:!(window.webkit&&window.webkit.messageHandlers&&window.webkit.messageHandlers.native),title:document.title})") { value, error in
                result["page"] = value ?? NSNull(); result["javascriptError"] = error?.localizedDescription ?? ""
                let second = url.deletingLastPathComponent().appendingPathComponent("second.html")
                view.load(URLRequest(url: second))
                self.waitUntil({ !view.isLoading && view.title == "Second Page" }, timeout: 8) { secondOK in
                    result["secondPageLoaded"] = secondOK; result["backAvailable"] = view.canGoBack
                    view.goBack()
                    self.waitUntil({ !view.isLoading && view.title == "ShiYan Browser Fixture" }, timeout: 8) { backOK in
                        result["backNavigation"] = backOK; result["forwardAvailable"] = view.canGoForward
                        result["historyRecorded"] = self.history.count >= 2
                        result["rejectFileURL"] = self.validURL("file:///etc/passwd") == nil
                        result["rejectJavascriptURL"] = self.validURL("javascript:alert(1)") == nil
                        view.takeSnapshot(with: nil) { image, _ in
                            if let tiff = image?.tiffRepresentation, let bitmap = NSBitmapImageRep(data: tiff), let png = bitmap.representation(using: .png, properties: [:]) {
                                try? png.write(to: self.stateURL.deletingLastPathComponent().appendingPathComponent("native-browser.png"))
                            }
                            self.extendedSelfTest(url: url, view: view, initial: result, completion: completion)
                        }
                    }
                }
            }
        }
    }
    private func extendedSelfTest(url: URL, view: WKWebView, initial: [String: Any],
                                  completion: @escaping ([String: Any]) -> Void) {
        guard CommandLine.arguments.contains("--self-test-workbench") else { return }
        var result = initial
        view.goForward()
        waitUntil({ !view.isLoading && view.title == "Second Page" }, timeout: 8) { [weak self] forwardOK in
            guard let self = self else { return }
            result["forwardNavigation"] = forwardOK
            view.reload()
            self.waitUntil({ !view.isLoading && view.title == "Second Page" }, timeout: 8) { reloadOK in
                result["reloadPage"] = reloadOK
                self.handle(["op":"bookmark","url":url.absoluteString,"title":"Browser QA"])
                result["bookmarkAdded"] = self.bookmarks.contains(where: { $0["url"] as? String == url.absoluteString })
                self.handle(["op":"searchEngine","value":"duckduckgo"])
                if let host = self.host, let window = self.window {
                    let restored = BrowserWorkspace(host: host, window: window,
                        directory: self.stateURL.deletingLastPathComponent(), isInternal: self.isInternal, emit: { _ in })
                    result["searchEngineRestored"] = restored.snapshot()["searchEngine"] as? String == "duckduckgo"
                    result["bookmarkRestored"] = (restored.snapshot()["bookmarks"] as? [[String:Any]])?.contains(where: { $0["url"] as? String == url.absoluteString }) == true
                    result["historyRestored"] = (restored.snapshot()["history"] as? [[String:Any]])?.isEmpty == false
                }
                self.desiredVisible = false; self.applyVisibility()
                result["nativeBrowserHides"] = view.isHidden
                self.desiredVisible = true; self.applyVisibility()
                result["nativeBrowserRestores"] = !view.isHidden
                let secondID = UUID().uuidString
                let count = self.views.count
                let extra = self.create(secondID)
                result["independentNativeTab"] = extra != nil && extra !== view && self.views.count == count + 1
                self.handle(["op":"close","tabId":secondID])
                result["nativeTabClosed"] = self.views.count == count
                self.testDownloadTarget = self.stateURL.deletingLastPathComponent().appendingPathComponent("native-download-\(UUID().uuidString).bin")
                self.testDownloadSource = url.deletingLastPathComponent().appendingPathComponent("download.bin")
                view.load(URLRequest(url: self.testDownloadSource!))
                self.waitUntil({ self.downloadRecords.first?["status"] as? String == "completed" }, timeout: 15) { downloadOK in
                    result["actualDownloadCompleted"] = downloadOK
                    result["downloadDoesNotShowPageError"] = self.identifier(for: view).map { (self.errors[$0] ?? "").isEmpty } ?? false
                    if let target = self.testDownloadTarget {
                        result["downloadBytesMatch"] = (try? Data(contentsOf: target)) == Data("SHIYAN_NATIVE_DOWNLOAD_OK\n".utf8)
                    }
                    self.testDownloadTarget = nil; self.testDownloadSource = nil
                    let cookie = HTTPCookie(properties: [.domain:"127.0.0.1",.path:"/",.name:"shiyan_qa",.value:"test"])
                    guard let cookie = cookie else { completion(result); return }
                    self.dataStore.httpCookieStore.setCookie(cookie) {
                        self.dataStore.removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast) {
                            self.dataStore.httpCookieStore.getAllCookies { cookies in
                                result["clearWebsiteData"] = !cookies.contains(where: { $0.name == "shiyan_qa" })
                                self.handle(["op":"clearHistory"])
                                result["clearBrowserHistory"] = self.history.isEmpty
                                self.handle(["op":"searchEngine","value":"bing"])
                                completion(result)
                            }
                        }
                    }
                }
            }
        }
    }

    private func waitUntil(_ condition: @escaping () -> Bool, timeout: TimeInterval, completion: @escaping (Bool) -> Void) {
        testTimer?.invalidate()
        let deadline = Date().addingTimeInterval(timeout)
        testTimer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] timer in
            if condition() { timer.invalidate(); self?.testTimer = nil; completion(true) }
            else if Date() >= deadline { timer.invalidate(); self?.testTimer = nil; completion(false) }
        }
    }
}
