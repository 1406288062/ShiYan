import XCTest

final class DrawerFullPageUITests: XCTestCase {
    override func setUp() { super.setUp(); continueAfterFailure = false }

    private func openChat() -> XCUIApplication {
        let app = XCUIApplication(bundleIdentifier: "com.shiyan.enhancer")
        app.launchEnvironment["SHIYAN_UI_TEST_OPEN_AGENT"] = "1"
        app.launch()
        XCTAssertTrue(app.buttons["历史会话"].waitForExistence(timeout: 25))
        assertOpen(false, app)
        return app
    }
    private func assertOpen(_ open: Bool, _ app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) {
        let search = app.buttons["搜索会话"]
        let newChat = app.buttons["新建聊天"]
        let settled = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
             
             
            open ? (search.exists && newChat.frame.minX > app.windows.firstMatch.frame.width)
                 : (newChat.exists && newChat.isHittable && newChat.frame.maxX <= app.frame.width + 1)
        }, object: nil)
        let result = XCTWaiter.wait(for: [settled], timeout: 5)
        if result != .completed { capture("drawer-state-failure-\(open)") }
        XCTAssertEqual(result, .completed, app.debugDescription, file: file, line: line)
    }
    private func drag(_ app: XCUIApplication, from: CGVector, to: CGVector) {
        app.coordinate(withNormalizedOffset: from).press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: to))
    }
    private func close(_ app: XCUIApplication) {
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.94, dy: 0.40)).tap()
        assertOpen(false, app)
    }
    private func capture(_ title: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = title; attachment.lifetime = .keepAlways; add(attachment)
    }
    func testFullPageStartPositionsAndRepeatedClose() {
        let app = openChat()
        let starts = [CGVector(dx: 0.015, dy: 0.40), CGVector(dx: 0.22, dy: 0.32),
                      CGVector(dx: 0.48, dy: 0.50), CGVector(dx: 0.72, dy: 0.60),
                      CGVector(dx: 0.42, dy: 0.12), CGVector(dx: 0.40, dy: 0.78)]
        for (index, start) in starts.enumerated() {
            drag(app, from: start, to: CGVector(dx: 0.97, dy: start.dy + (index % 2 == 0 ? 0.015 : -0.015)))
            assertOpen(true, app)
            capture("fullpage-open-\(index)")
            if index % 2 == 0 { close(app) }
            else {
                drag(app, from: CGVector(dx: 0.92, dy: 0.42), to: CGVector(dx: 0.38, dy: 0.42))
                assertOpen(false, app)
            }
        }
        print("SHIYAN_FULLPAGE_SIX_REGIONS_OPEN_CLOSE_PASSED")
    }
    func testVerticalScrollAndGestureRecovery() {
        let app = openChat()
        drag(app, from: CGVector(dx: 0.45, dy: 0.66), to: CGVector(dx: 0.46, dy: 0.28))
        assertOpen(false, app)
        drag(app, from: CGVector(dx: 0.45, dy: 0.28), to: CGVector(dx: 0.46, dy: 0.66))
        assertOpen(false, app)
        drag(app, from: CGVector(dx: 0.45, dy: 0.40), to: CGVector(dx: 0.93, dy: 0.40))
        assertOpen(true, app); close(app)
        print("SHIYAN_FULLPAGE_VERTICAL_SCROLL_AND_RECOVERY_PASSED")
    }
    func testKeyboardReasoningBackdropAndHistoryButton() {
        let app = openChat()
        let field = app.descendants(matching: .any).matching(identifier: "agent-message-input").firstMatch
        field.tap()
         
         
        field.typeText("z")
        XCTAssertTrue((field.value as? String ?? "").hasSuffix("z"))
        field.typeText(XCUIKeyboardKey.delete.rawValue)
        drag(app, from: CGVector(dx: 0.35, dy: 0.30), to: CGVector(dx: 0.93, dy: 0.30))
        assertOpen(true, app)
        XCTAssertFalse(app.keyboards.firstMatch.exists)
        close(app)
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "推理档位：")).firstMatch.tap()
        XCTAssertTrue(app.staticTexts["reasoning-current-title"].waitForExistence(timeout: 5))
        drag(app, from: CGVector(dx: 0.35, dy: 0.40), to: CGVector(dx: 0.93, dy: 0.40))
        assertOpen(true, app); close(app)
        app.buttons["历史会话"].tap()
        assertOpen(true, app); capture("fullpage-history-button"); close(app)
        print("SHIYAN_FULLPAGE_KEYBOARD_REASONING_BACKDROP_BUTTON_PASSED")
    }
    func testSidebarSearchSelectionAndImageGesture() throws {
        let app = openChat()
        app.buttons["历史会话"].tap()
        assertOpen(true, app)
        capture("drawer-controls-before-search")
         
        app.buttons["搜索会话"].coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        let search = app.textFields["session-search"]
        XCTAssertTrue(search.waitForExistence(timeout: 5), app.debugDescription)
        search.tap(); search.typeText("生成蓝圆与绿方图")
        let row = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label CONTAINS %@", "session-row-", "生成蓝圆与绿方图")).firstMatch
        guard row.waitForExistence(timeout: 5) else { throw XCTSkip("Existing image test conversation not available") }
        row.tap(); assertOpen(false, app)
        let image = app.buttons.matching(identifier: "查看图片").firstMatch
        guard image.waitForExistence(timeout: 10) else { throw XCTSkip("Selected conversation has no loaded image fixture") }
        if !image.isHittable {
            drag(app, from: CGVector(dx: 0.50, dy: 0.32), to: CGVector(dx: 0.50, dy: 0.72))
        }
        capture("drawer-gesture-image-origin")
        let start = image.coordinate(withNormalizedOffset: CGVector(dx: 0.25, dy: 0.50))
        start.press(forDuration: 0.05, thenDragTo: start.withOffset(CGVector(dx: 150, dy: 5)))
        assertOpen(true, app); close(app)
        print("SHIYAN_FULLPAGE_SIDEBAR_SEARCH_SELECT_AND_IMAGE_ORIGIN_PASSED")
    }

}
