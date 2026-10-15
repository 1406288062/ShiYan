import AppKit
import Foundation

 
final class WorkspaceDivider: NSView {
    var dividerID = ""
    var verticalAxis = false
    var onDrag: ((String, String, CGFloat, CGFloat) -> Void)?
    override var acceptsFirstResponder: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func resetCursorRects() { addCursorRect(bounds, cursor: verticalAxis ? .resizeUpDown : .resizeLeftRight) }
    private func report(_ phase: String, event: NSEvent) {
        guard let parent = superview else { return }
        let p = parent.convert(event.locationInWindow, from: nil)
        onDrag?(dividerID, phase, p.x, parent.bounds.height - p.y)
    }
    override func mouseDown(with event: NSEvent) { report("start", event: event) }
    override func mouseDragged(with event: NSEvent) { report("move", event: event) }
    override func mouseUp(with event: NSEvent) { report("end", event: event) }
}
private final class WorkspaceMenuTarget: NSObject {
    let callback: (String) -> Void
    init(_ callback: @escaping (String) -> Void) { self.callback = callback }
    @objc func selectItem(_ sender: NSMenuItem) { if let id = sender.representedObject as? String { callback(id) } }
}
final class WorkspaceChrome {
    private weak var host: NSView?
    private let emit: ([String: Any]) -> Void
    private var dividers: [String: WorkspaceDivider] = [:]
    init(host: NSView, emit: @escaping ([String: Any]) -> Void) { self.host = host; self.emit = emit }
    func updateDividers(_ body: [String: Any]) {
        guard let host = host, let items = body["items"] as? [[String: Any]] else { return }
        let valid = Set(["leftResizeHandle", "rightResizeHandle", "bottomResizeHandle"])
        for item in items {
            guard let id = item["id"] as? String, valid.contains(id), let r = item["rect"] as? [String: Double],
                  let x = r["x"], let y = r["y"], let w = r["width"], let h = r["height"],
                  [x,y,w,h].allSatisfy({ $0.isFinite }) else { continue }
            let view: WorkspaceDivider
            if let old = dividers[id] { view = old }
            else {
                view = WorkspaceDivider(frame: .zero); view.dividerID = id
                view.onDrag = { [weak self] id, phase, x, y in self?.emit(["type":"workspaceDivider", "id":id, "phase":phase, "x":x, "y":y]) }
                view.setAccessibilityLabel(id == "bottomResizeHandle" ? "调整底部终端高度" : "调整侧边栏宽度")
                dividers[id] = view; host.addSubview(view)
            }
            var changed = false
            let vertical = item["axis"] as? String == "y"
            if view.verticalAxis != vertical { view.verticalAxis = vertical; changed = true }
            let rect = NSRect(x: CGFloat(x), y: host.bounds.height-CGFloat(y)-CGFloat(h), width: CGFloat(max(0,w)), height: CGFloat(max(0,h)))
            let frame = rect.intersection(host.bounds)
            if view.frame != frame { view.frame = frame; changed = true }
            let hidden = !(item["visible"] as? Bool ?? false) || frame.isEmpty
            if view.isHidden != hidden { view.isHidden = hidden; changed = true }
            if changed { host.window?.invalidateCursorRects(for: view) }
        }
        bringToFront()
    }
    func bringToFront() {
        guard let host = host, !dividers.isEmpty else { return }
        let dividerIDs = Set(dividers.values.map { ObjectIdentifier($0) })
        let topIDs = Set(host.subviews.suffix(dividers.count).map { ObjectIdentifier($0) })
        if topIDs == dividerIDs { return }
        for view in dividers.values { host.addSubview(view, positioned: .above, relativeTo: nil) }
    }
    private func makeMenu(_ items: [[String: Any]], target: WorkspaceMenuTarget, depth: Int = 0) -> NSMenu {
        let menu = NSMenu(); menu.autoenablesItems = false
        menu.font = NSFont.menuFont(ofSize: max(11, NSFont.menuFont(ofSize: 0).pointSize - 1))
        guard depth < 4 else { return menu }
        for value in items.prefix(60) {
            if value["separator"] as? Bool == true { menu.addItem(.separator()); continue }
            guard let label = value["label"] as? String else { continue }
            let item = NSMenuItem(title: String(label.prefix(160)), action: #selector(WorkspaceMenuTarget.selectItem(_:)), keyEquivalent: "")
            item.target = target; item.representedObject = value["id"] as? String
            item.isEnabled = value["enabled"] as? Bool ?? true
            item.state = value["checked"] as? Bool == true ? .on : .off
            if let children = value["children"] as? [[String: Any]] { item.submenu = makeMenu(children, target: target, depth: depth+1) }
            menu.addItem(item)
        }
        return menu
    }
    func presentMenu(_ body: [String: Any]) {
        guard let host = host, let id = body["menuId"] as? String, UUID(uuidString: id) != nil,
              let items = body["items"] as? [[String: Any]], let x = body["x"] as? Double, let y = body["y"] as? Double,
              x.isFinite, y.isFinite else { return }
        let target = WorkspaceMenuTarget { [weak self] selected in self?.emit(["type":"workspaceMenuSelection", "menuId":id, "itemId":selected]) }
        let menu = makeMenu(items, target: target)
        let point = NSPoint(x: max(0,min(host.bounds.width-20,CGFloat(x))), y: max(0,min(host.bounds.height,host.bounds.height-CGFloat(y))))
        withExtendedLifetime(target) { _ = menu.popUp(positioning: nil, at: point, in: host) }
        emit(["type":"workspaceMenuClosed", "menuId":id])
    }
    func close() { for view in dividers.values { view.removeFromSuperview() }; dividers.removeAll() }
    func simulateRightDividerForTest(delta: CGFloat) -> [String: Any] {
        guard CommandLine.arguments.contains("--self-test-workbench"), let host = host,
              let window = host.window, let divider = dividers["rightResizeHandle"], !divider.isHidden else {
            return ["nativeRealDividerAvailable":false]
        }
        let start = NSPoint(x:divider.frame.midX,y:divider.frame.midY)
        let hit = host.hitTest(start) === divider
        var count = 0
        for (type, number, amount) in [(NSEvent.EventType.leftMouseDown,1,CGFloat(0)),(.leftMouseDragged,2,delta),(.leftMouseUp,3,delta)] {
            let location = host.convert(NSPoint(x:start.x+amount,y:start.y),to:nil)
            if let event = NSEvent.mouseEvent(with:type,location:location,modifierFlags:[],timestamp:0,windowNumber:window.windowNumber,context:nil,eventNumber:number,clickCount:1,pressure:1) {
                if type == .leftMouseDown { divider.mouseDown(with:event) }
                else if type == .leftMouseDragged { divider.mouseDragged(with:event) }
                else { divider.mouseUp(with:event) }
                count += 1
            }
        }
        return ["nativeRealDividerAvailable":true,"nativeRealDividerHitTest":hit,"nativeRealDividerEventsPosted":count == 3]
    }
     
    func selfTest() -> [String: Any] {
        guard let host = host, let window = host.window else { return ["nativeChromeTestReady":false] }
        let view = WorkspaceDivider(frame: NSRect(x: host.bounds.width-12,y:40,width:10,height:180))
        view.dividerID = "nativeChromeSelfTest"; var phases: [String] = []
        view.onDrag = { _,phase,_,_ in phases.append(phase) }
        host.addSubview(view, positioned: .above, relativeTo: nil)
        let hit = host.hitTest(NSPoint(x:view.frame.midX,y:view.frame.midY)) === view
        let p = host.convert(NSPoint(x:view.frame.midX,y:view.frame.midY),to:nil)
        for (type,number) in [(NSEvent.EventType.leftMouseDown,1),(.leftMouseDragged,2),(.leftMouseUp,3)] {
            if let event = NSEvent.mouseEvent(with:type,location:p,modifierFlags:[],timestamp:0,windowNumber:window.windowNumber,context:nil,eventNumber:number,clickCount:1,pressure:1) {
                if type == .leftMouseDown { view.mouseDown(with:event) }
                else if type == .leftMouseDragged { view.mouseDragged(with:event) }
                else { view.mouseUp(with:event) }
            }
        }
        view.removeFromSuperview()
        let target = WorkspaceMenuTarget { _ in }
        let menu = makeMenu([["id":"copy","label":"复制","enabled":true],["separator":true],["id":"editor","label":"打开方式","children":[["id":"test","label":"测试编辑器"]]]],target:target)
        return ["nativeDividerHitAboveBrowser":hit,"nativeDividerDragLifecycle":phases == ["start","move","end"],"nativeCompactMenuStructure":menu.items.count == 3 && menu.items[2].submenu?.items.count == 1]
    }
}
