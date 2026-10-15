import XCTest
import UIKit

final class V2AcceptanceUITests: XCTestCase {
    override func setUp() { super.setUp(); continueAfterFailure = false }
    private func start(chat: Bool = false, fixture: String? = nil, geometry: Bool = false) -> XCUIApplication {
        let app = XCUIApplication(bundleIdentifier: "com.shiyan.enhancer")
        app.launchEnvironment["SHIYAN_V2_RECORD_LAYOUT"] = "1"
        if chat { app.launchEnvironment["SHIYAN_UI_TEST_OPEN_AGENT"] = "1" }
        if let fixture { app.launchEnvironment["SHIYAN_UI_TEST_IMAGE"] = fixture }
        if geometry { app.launchEnvironment["SHIYAN_V2_RECORD_GEOMETRY"] = "1" }
        app.launch()
        XCTAssertTrue(app.buttons[chat ? "新建聊天" : "AI Agent"].waitForExistence(timeout: 25), app.debugDescription)
        return app
    }
    private func shot(_ name: String) {
        let a = XCTAttachment(screenshot: XCUIScreen.main.screenshot()); a.name = name; a.lifetime = .keepAlways; add(a)
    }
    private func row(_ name: String, in app: XCUIApplication) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label == %@", "session-row-", name)).firstMatch
    }
    private func sidebar(_ app: XCUIApplication) {
        app.buttons["历史会话"].tap()
        XCTAssertTrue(app.buttons["搜索会话"].waitForExistence(timeout: 5))
        let list = app.scrollViews["agent-sidebar-scroll"]
        let visiblyOpen = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in list.exists && abs(list.frame.minX) < 1 }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [visiblyOpen], timeout: 5), .completed, "Sidebar must visibly open, not just remain in the hidden accessibility tree")
    }
    private func select(_ name: String, in app: XCUIApplication) {
        sidebar(app); let target = row(name, in: app)
        XCTAssertTrue(target.waitForExistence(timeout: 6)); target.tap()
        Thread.sleep(forTimeInterval: 0.45)  
    }
    private func chooseFeature(_ title: String, in app: XCUIApplication) {
        let tab = app.buttons["feature-" + title]; tab.tap()
        let selected = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in (tab.value as? String) == "已选中" }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [selected], timeout: 5), .completed, "Feature selection must settle before screenshots")
        Thread.sleep(forTimeInterval: 0.3)
    }
    private func waitGone(_ element: XCUIElement, timeout: TimeInterval = 5) {
        let p = NSPredicate(format: "exists == false")
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: p, object: element)], timeout: timeout), .completed)
    }

    func test01UnifiedPanelAndExplicitImagePicker() throws {
        let app = start()
        let features = [("变清晰", "photo-start-enhance"), ("AI 消除", "photo-start-remove"), ("老照片上色", "photo-start-colorize")]
        for (title, id) in features {
            chooseFeature(title, in: app)
            let action = app.buttons[id]
            XCTAssertTrue(action.waitForExistence(timeout: 4)); XCTAssertFalse(action.isEnabled)
            action.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
            XCTAssertTrue(app.buttons[id].exists)
            XCTAssertFalse(app.buttons["Cancel"].exists)
            shot("v2-home-empty-" + title)
        }
        chooseFeature("变清晰", in: app)
        let panel = app.descendants(matching: .any)["home-tool-panel"].firstMatch
        let image = app.descendants(matching: .any)["home-image-area"].firstMatch
        XCTAssertTrue(panel.exists); XCTAssertTrue(image.exists)
         
        XCTAssertEqual(panel.frame.minX - 6, image.frame.minX, accuracy: 1)
        XCTAssertEqual(panel.frame.maxX + 6, image.frame.maxX, accuracy: 1)
        XCTAssertEqual(image.frame.minX, app.frame.width - image.frame.maxX, accuracy: 1)
        print("V2_HOME_ALIGNED", image.frame, panel.frame)
        image.tap()
        let cancel = app.buttons.matching(NSPredicate(format: "label IN %@", ["Cancel", "取消"])).firstMatch
        XCTAssertTrue(cancel.waitForExistence(timeout: 7), app.debugDescription)
        shot("v2-explicit-image-picker"); cancel.tap()
        print("V2_EXPLICIT_PICKER_AND_EMPTY_DISABLE_PASS")
    }

    func test02CompactBubbleAndOutsideKeyboardDismiss() throws {
        let app = start(chat: true)
        select("V2验收·气泡", in: app)
        let bubble = app.staticTexts.matching(NSPredicate(format: "identifier BEGINSWITH %@", "user-bubble-")).firstMatch
        XCTAssertTrue(bubble.waitForExistence(timeout: 5)); XCTAssertLessThan(bubble.frame.width, 110)
        XCTAssertGreaterThan(bubble.frame.maxX, app.frame.width * 0.85)
        shot("v2-short-message-bubble")
        print("V2_SHORT_BUBBLE_FRAME",bubble.frame)
        let field = app.textFields["agent-message-input"]
        field.tap(); field.typeText("V2 draft kept")
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        shot("v2-keyboard-open")
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.72, dy: 0.36)).tap()
        waitGone(app.keyboards.firstMatch)
        XCTAssertTrue((field.value as? String ?? "").contains("V2 draft kept"))
        shot("v2-keyboard-dismissed-draft-kept")
        print("V2_BUBBLE_AND_KEYBOARD_PASS")
    }

    func test03PinStateAndNoContentPreview() throws {
        let app = start(chat: true)
        sidebar(app)
        print("V2_PIN_SIDEBAR_HIERARCHY",app.debugDescription)
        shot("v2-before-pin-hierarchy")
        var target = app.descendants(matching: .any)["session-row-C8C19EBD-61F9-5646-8211-A14089A401FE"].firstMatch
        XCTAssertTrue(target.waitForExistence(timeout: 5),app.debugDescription); target.press(forDuration: 0.9)
        let pin = app.buttons.matching(NSPredicate(format: "label == %@ OR identifier == %@", "置顶", "session-pin")).firstMatch
        XCTAssertTrue(pin.waitForExistence(timeout: 6), app.debugDescription)
        XCTAssertFalse(app.staticTexts["V2_CONTEXT_PREVIEW_MUST_NOT_APPEAR"].exists)
        shot("v2-menu-pin-without-content-preview"); pin.tap()
        waitGone(pin)
        Thread.sleep(forTimeInterval: 0.45)
        target = app.descendants(matching: .any)["session-row-C8C19EBD-61F9-5646-8211-A14089A401FE"].firstMatch
        XCTAssertTrue(target.waitForExistence(timeout: 5))
        XCTAssertFalse((target.value as? String ?? "").contains("当前会话"))
        target.press(forDuration: 0.9)
        let unpin = app.buttons.matching(NSPredicate(format: "label == %@ OR identifier == %@", "取消置顶", "session-unpin")).firstMatch
        XCTAssertTrue(unpin.waitForExistence(timeout: 6), app.debugDescription)
        XCTAssertEqual(unpin.label, "取消置顶")
        shot("v2-menu-unpin-slashed-symbol"); unpin.tap()
        target = app.descendants(matching: .any)["session-row-C8C19EBD-61F9-5646-8211-A14089A401FE"].firstMatch
        XCTAssertFalse((target.value as? String ?? "").contains("已置顶"))
        print("V2_PIN_UNPIN_AND_PREVIEW_PASS")
    }

    func test04PointedDeleteConfirmation() throws {
        let app = start(chat: true); sidebar(app)
        let target = row("V2验收·删除", in: app)
        XCTAssertTrue(target.waitForExistence(timeout: 5)); target.press(forDuration: 0.9)
        app.buttons["删除"].tap()
        let delete = app.buttons["confirm-delete-conversation"]
        XCTAssertTrue(delete.waitForExistence(timeout: 6), app.debugDescription)
        let popover = app.descendants(matching: .any)["delete-conversation-popover"].firstMatch
        XCTAssertTrue(popover.exists)
        XCTAssertEqual(popover.frame.midX, app.frame.width * 0.375, accuracy: 2)
        XCTAssertLessThan(popover.frame.maxY, target.frame.minY + 1)
        XCTAssertGreaterThan(delete.frame.width, 200)
        print("V2_DELETE_POPOVER_FRAME",popover.frame,"TARGET",target.frame)
        shot("v2-delete-callout-above-row")
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.08, dy: 0.88)).tap()
        waitGone(delete); XCTAssertTrue(target.exists)
        print("V2_DELETE_POPOVER_CANCEL_SAFE_PASS")
    }

    func test05StableCornersAndWholeRowFade() throws {
        let app = start(chat: true, geometry: true)
        select("V2验收·渐隐", in: app)
        sidebar(app); shot("v2-sidebar-open-no-wedges")
        let list = app.scrollViews["agent-sidebar-scroll"]
        XCTAssertTrue(list.exists)
        list.coordinate(withNormalizedOffset: CGVector(dx: 0.45, dy: 0.72)).press(forDuration: 0.05,
            thenDragTo: list.coordinate(withNormalizedOffset: CGVector(dx: 0.45, dy: 0.32)), withVelocity: .slow, thenHoldForDuration: 0)
        shot("v2-sidebar-symbol-and-title-fade")
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.94, dy: 0.45)).press(forDuration: 0.05,
            thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.08, dy: 0.45)),
            withVelocity: XCUIGestureVelocity(rawValue: 110), thenHoldForDuration: 0.2)
        XCTAssertTrue(app.buttons["历史会话"].waitForExistence(timeout: 5));shot("v2-drawer-closed-device-corners")
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.35, dy: 0.45)).press(forDuration: 0.05,
            thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.96, dy: 0.45)),
            withVelocity: XCUIGestureVelocity(rawValue: 110), thenHoldForDuration: 0.2)
        XCTAssertTrue(app.buttons["搜索会话"].waitForExistence(timeout: 5));shot("v2-drawer-reopened-fixed-corners")
        print("V2_DRAWER_GEOMETRY_TRACE_READY")
    }

    func test06GridPinkAndListBlue() throws {
        let app = start();app.buttons["clock.arrow.circlepath"].tap()
        let more = app.buttons["history-more-menu"]
        XCTAssertTrue(more.waitForExistence(timeout: 6));more.tap();app.buttons["网格"].tap()
        more.tap();app.buttons["选择"].tap()
        let card = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label CONTAINS %@", "history-entry-", "V2 White Contrast")).firstMatch
        XCTAssertTrue(card.waitForExistence(timeout: 5));shot("v2-grid-thin-ring-light-gray")
        card.tap();shot("v2-grid-selected-pink")
        let pink = colorCounts(in: CGRect(x: card.frame.maxX - 39, y: card.frame.minY + 9, width: 30, height: 30), app: app)
        XCTAssertGreaterThan(pink.0, 20,"Expected pink grid selection, got \(pink)")
        print("V2_GRID_PINK_PIXELS",pink)
        let done = app.buttons["关闭"]
        XCTAssertTrue(done.exists);done.tap();more.tap();app.buttons["列表"].tap();more.tap();app.buttons["选择"].tap()
        let listRow = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label CONTAINS %@", "history-entry-", "V2 White Contrast")).firstMatch
        XCTAssertTrue(listRow.waitForExistence(timeout: 5));listRow.tap();shot("v2-list-selected-blue")
        let blue = colorCounts(in: CGRect(x: listRow.frame.minX, y: listRow.frame.minY, width: 38, height: listRow.frame.height), app: app)
        XCTAssertGreaterThan(blue.1, 15,"Expected blue list selection, got \(blue)")
        print("V2_LIST_BLUE_PIXELS",blue)
        print("V2_GRID_LIST_COLOR_PASS")
    }

    func test07AdaptiveImageAndPhotoStartAvailability() throws {
        var app = start(fixture: "v2-wide.jpg")
        let first = app.descendants(matching: .any)["home-tool-panel"].firstMatch.frame
        XCTAssertTrue(app.buttons["photo-start-enhance"].isEnabled)
        shot("v2-home-wide-image-unified-panel")
        app.terminate();app = start(fixture: "v2-tall.jpg")
        let second = app.descendants(matching: .any)["home-tool-panel"].firstMatch.frame
        XCTAssertGreaterThan(second.minY, first.minY + 30)
        XCTAssertEqual(first.minX, second.minX, accuracy: 1)
        shot("v2-home-tall-image-adaptive")
        for title in ["AI 消除","老照片上色"] {
            chooseFeature(title, in: app)
            XCTAssertTrue(app.buttons[title == "AI 消除" ? "photo-start-remove" : "photo-start-colorize"].isEnabled)
            shot("v2-home-loaded-"+title)
        }
        print("V2_ADAPTIVE_IMAGE_PASS",first,second)
    }

    private func colorCounts(in rect: CGRect, app: XCUIApplication) -> (Int, Int) {
        guard let full = XCUIScreen.main.screenshot().image.cgImage else { return (0,0) }
        let scale = CGFloat(full.width) / app.frame.width
        let px = CGRect(x: rect.minX * scale, y: rect.minY * scale, width: rect.width * scale, height: rect.height * scale).integral
        guard let image = full.cropping(to: px) else { return (0,0) }
        var data = [UInt8](repeating: 0, count: image.width * image.height * 4)
        guard let ctx = CGContext(data: &data, width: image.width, height: image.height, bitsPerComponent: 8, bytesPerRow: image.width * 4,
            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue) else { return (0,0) }
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
        var pink = 0, blue = 0
        for i in stride(from: 0, to: data.count, by: 4) {
            let r=Int(data[i]),g=Int(data[i+1]),b=Int(data[i+2])
            if r > 210 && g < 180 && b > g && b < 210 { pink += 1 }
            if b > 170 && r < 100 && g < 210 { blue += 1 }
        }
        return (pink,blue)
    }
}
