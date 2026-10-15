import XCTest

final class ShiyanUITests: XCTestCase {
    override func setUp() { super.setUp(); continueAfterFailure = false }
    private func capture(_ name: String) {
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = name; shot.lifetime = .keepAlways; add(shot)
    }
    private func openChat() -> XCUIApplication {
        let app = XCUIApplication(bundleIdentifier: "com.shiyan.enhancer")
        app.launchEnvironment["SHIYAN_UI_TEST_OPEN_AGENT"] = "1"
        app.launch()
        XCTAssertTrue(app.buttons["新建聊天"].waitForExistence(timeout: 25))
        return app
    }
    private func input(_ app: XCUIApplication) -> XCUIElement {
        let element = app.descendants(matching: .any).matching(identifier: "agent-message-input").firstMatch
        if element.waitForExistence(timeout: 3) { return element }
        if app.textViews.firstMatch.exists { return app.textViews.firstMatch }
        return app.textFields.firstMatch
    }
    private func openSidebar(_ app: XCUIApplication) {
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.015, dy: 0.40))
            .press(forDuration: 0.1, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.80, dy: 0.40)))
        XCTAssertTrue(waitForDrawerOpen(app))
    }
    private func swipeDrawer(_ app: XCUIApplication, x: CGFloat, y: CGFloat, distance: CGFloat = 100, rise: CGFloat = 0) {
        let origin = app.coordinate(withNormalizedOffset: .zero)
        let start = origin.withOffset(CGVector(dx: x, dy: app.frame.height * y))
        let end = origin.withOffset(CGVector(dx: x + distance, dy: app.frame.height * y + rise))
        start.press(forDuration: 0.05, thenDragTo: end)
    }
    private func waitForDrawerOpen(_ app: XCUIApplication) -> Bool {
        let state = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            let search = app.buttons["搜索会话"]
            let compose = app.buttons["新建聊天"]
            return search.exists && search.isHittable && (!compose.exists || !compose.isHittable)
        }, object: nil)
        return XCTWaiter.wait(for: [state], timeout: 6) == .completed
    }
    private func assertDrawerClosed(_ app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) {
        let state = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            let search = app.buttons["搜索会话"]
            let compose = app.buttons["新建聊天"]
            return compose.exists && compose.isHittable && (!search.exists || !search.isHittable)
        }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [state], timeout: 6), .completed, file: file, line: line)
    }
    private func closeDrawerByTap(_ app: XCUIApplication) {
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.92, dy: 0.35)).tap()
        assertDrawerClosed(app)
    }
    func testDrawerSwipeFromLeftMargin() throws {
        let app = openChat()
        swipeDrawer(app, x: 56, y: 0.40)
        let opened = waitForDrawerOpen(app)
        capture("drawer-start-56pt-short-swipe")
        XCTAssertTrue(opened, "A right swipe starting 56pt from the left edge must open the drawer.")
        closeDrawerByTap(app)
    }
    func testDrawerRepeatedShortAndDiagonalSwipes() throws {
        let app = openChat()
        let cases: [(CGFloat, CGFloat, CGFloat)] = [(6, 0.30, 0), (28, 0.45, 18), (56, 0.60, -18), (68, 0.40, 0), (40, 0.65, 20), (60, 0.50, -20)]
        for (index, item) in cases.enumerated() {
            swipeDrawer(app, x: item.0, y: item.1, distance: 88, rise: item.2)
            XCTAssertTrue(waitForDrawerOpen(app), "Open failed at cycle \(index), x=\(item.0)")
            if index % 2 == 0 { closeDrawerByTap(app) }
            else {
                app.coordinate(withNormalizedOffset: CGVector(dx: 0.92, dy: 0.42))
                    .press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.52, dy: 0.42)))
                assertDrawerClosed(app)
            }
        }
        capture("drawer-six-repeat-swipes-passed")
        print("SHIYAN_DRAWER_SIX_OPEN_CLOSE_CYCLES_PASSED")
    }
    func testDrawerIgnoresVerticalAndAcceptsCenterSwipes() throws {
        let app = openChat()
        for pair: (CGFloat, CGFloat) in [(0.65, 0.32), (0.32, 0.65)] {
            app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: 56, dy: app.frame.height * pair.0))
                .press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: 62, dy: app.frame.height * pair.1)))
            assertDrawerClosed(app)
        }
        swipeDrawer(app, x: app.frame.width * 0.4, y: 0.40, distance: app.frame.width * 0.3)
        XCTAssertTrue(waitForDrawerOpen(app))
        closeDrawerByTap(app)
        swipeDrawer(app, x: 56, y: 0.45)
        XCTAssertTrue(waitForDrawerOpen(app))
        closeDrawerByTap(app)
        print("SHIYAN_DRAWER_VERTICAL_AND_RECOVERY_PASSED")
    }
    func testDrawerSwipeWhileInputFocused() throws {
        let app = openChat()
        input(app).tap()
        swipeDrawer(app, x: 56, y: 0.30)
        XCTAssertTrue(waitForDrawerOpen(app))
        XCTAssertFalse(app.keyboards.firstMatch.exists)
        capture("drawer-with-input-focused")
        closeDrawerByTap(app)
    }
    func testExploreV2() throws {
        let app = openChat()
        app.buttons["新建聊天"].tap()
        sleep(2)
        print("V2_UI_DUMP_START")
        print(app.debugDescription)
        print("V2_UI_DUMP_END")
        capture("v2-main-inspection")
    }
    func testGeneralTextConversation() throws {
        let app = openChat()
        app.buttons["新建聊天"].tap()
        let field = input(app)
        XCTAssertTrue(field.waitForExistence(timeout: 10), app.debugDescription)
        field.tap(); field.typeText("Reply exactly SHIYAN_TEXT_OK_20261008"); sleep(1)
        print("QA_COMPOSER_BEFORE_SEND", field.value ?? "nil")
        capture("00-composer-before-send")
        app.buttons["发送"].tap()
        capture("01-text-processing")
        XCTAssertFalse(app.secureTextFields["服务器 Token"].exists)
        let answer = app.staticTexts["SHIYAN_TEXT_OK_20261008"]
        XCTAssertTrue(answer.waitForExistence(timeout: 150), app.debugDescription)
        capture("02-text-result")
        print("SHIYAN_QA_TEXT_RESULT_VISIBLE")
        app.terminate(); app.launch()
        XCTAssertTrue(answer.waitForExistence(timeout: 25))
        capture("03-text-after-relaunch")
        print("SHIYAN_QA_SESSION_PERSISTENCE_PASSED")
    }
    func testSidebarAndReasoning() throws {
        let app = openChat()
        let control = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "推理档位：")).firstMatch
        XCTAssertTrue(control.waitForExistence(timeout: 10)); control.tap()
        XCTAssertTrue(app.staticTexts["reasoning-current-title"].waitForExistence(timeout: 5), app.debugDescription)
        sleep(1)
        capture("04-reasoning-control")
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.73, dy: 0.88)).tap()
        capture("05-reasoning-changed")
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.50, dy: 0.30)).tap()
        openSidebar(app); capture("06-sidebar")
        let row = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "session-row-")).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 10), app.debugDescription)
        row.press(forDuration: 1.1)
        capture("07-menu-after-press")
        XCTAssertTrue(app.buttons["重命名"].waitForExistence(timeout: 10), app.debugDescription)
        capture("07-session-long-press")
        if app.buttons["置顶"].exists { app.buttons["置顶"].tap() }
        else { app.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.25)).tap() }
        row.press(forDuration: 0.8); app.buttons["重命名"].tap()
        let rename = app.textFields["rename-conversation-field"]
        XCTAssertTrue(rename.waitForExistence(timeout: 5))
        let original = rename.value as? String ?? ""
        rename.tap(); rename.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: original.count))
        rename.typeText("拾燕会话标题很长时应当保持一行并显示省略号")
        app.buttons["rename-conversation-save"].tap()
        capture("08-session-renamed-pinned")
        app.buttons["搜索会话"].tap()
        let search = app.textFields["session-search"]
        XCTAssertTrue(search.waitForExistence(timeout: 5))
        search.tap(); search.typeText("不存在的会话XYZ")
        XCTAssertTrue(app.staticTexts["没有匹配的会话"].waitForExistence(timeout: 5))
        capture("09-session-search")
        print("SHIYAN_QA_SIDEBAR_MENU_SEARCH_PASSED")
    }
    func testPhotoColorize() throws {
        let app = XCUIApplication(bundleIdentifier: "com.shiyan.enhancer")
        app.launchEnvironment["SHIYAN_UI_TEST_IMAGE"] = "shiyan-color-fixture.jpg"
        app.launch()
        XCTAssertTrue(app.buttons["老照片上色"].waitForExistence(timeout: 25))
        app.buttons["老照片上色"].tap()
        capture("10-colorize-before")
        XCTAssertTrue(app.buttons["开始上色"].waitForExistence(timeout: 10))
        app.buttons["开始上色"].tap()
        capture("11-colorize-running")
        XCTAssertFalse(app.secureTextFields["服务器 Token"].exists)
        let settled = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            app.buttons["保存结果"].exists || app.staticTexts["photo-error-message"].exists
        }, object: nil)
        _ = XCTWaiter.wait(for: [settled], timeout: 190)
        capture("photo-settled")
        XCTAssertTrue(app.buttons["保存结果"].exists, app.debugDescription)
        capture("12-colorize-result")
        app.buttons["clock.arrow.circlepath"].tap()
        XCTAssertTrue(app.staticTexts["历史记录"].waitForExistence(timeout: 10))
        capture("13-colorize-history")
        let entry = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label CONTAINS %@", "history-entry-", "老照片上色")).firstMatch
        XCTAssertTrue(entry.waitForExistence(timeout: 10)); entry.tap()
        XCTAssertTrue(app.buttons["下载图片"].waitForExistence(timeout: 10))
        capture("14-colorize-history-preview")
        print("SHIYAN_QA_COLORIZE_RESULT_AND_HISTORY_VISIBLE")
    }
    func testPhotoRemove() throws {
        let app = XCUIApplication(bundleIdentifier: "com.shiyan.enhancer")
        app.launchEnvironment["SHIYAN_UI_TEST_IMAGE"] = "shiyan-remove-fixture.jpg"
        app.launch()
        XCTAssertTrue(app.buttons["AI 消除"].waitForExistence(timeout: 25)); app.buttons["AI 消除"].tap()
        let canvas = app.descendants(matching: .any).matching(identifier: "removal-canvas").firstMatch
        XCTAssertTrue(canvas.waitForExistence(timeout: 10), app.debugDescription)
        if app.sliders.firstMatch.exists { app.sliders.firstMatch.adjust(toNormalizedSliderPosition: 1) }
        capture("15-remove-before")
        for y in [0.38, 0.46, 0.54, 0.62] {
            canvas.coordinate(withNormalizedOffset: CGVector(dx: 0.35, dy: y)).press(forDuration: 0.08, thenDragTo: canvas.coordinate(withNormalizedOffset: CGVector(dx: 0.65, dy: y)))
        }
        capture("16-remove-mask")
        let options = app.buttons.matching(identifier: "AI 消除").allElementsBoundByIndex
        let generate = try XCTUnwrap(options.max(by: { $0.frame.minY < $1.frame.minY }))
        generate.tap()
        capture("17-remove-running")
        XCTAssertFalse(app.secureTextFields["服务器 Token"].exists)
        let settled = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            app.buttons["保存结果"].exists || app.staticTexts["photo-error-message"].exists
        }, object: nil)
        _ = XCTWaiter.wait(for: [settled], timeout: 190)
        capture("photo-settled")
        XCTAssertTrue(app.buttons["保存结果"].exists, app.debugDescription)
        capture("18-remove-result")
        app.buttons["clock.arrow.circlepath"].tap()
        XCTAssertTrue(app.staticTexts["历史记录"].waitForExistence(timeout: 10))
        let entry = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label CONTAINS %@", "history-entry-", "AI 消除")).firstMatch
        XCTAssertTrue(entry.waitForExistence(timeout: 10))
        capture("19-remove-history")
        entry.tap(); XCTAssertTrue(app.buttons["下载图片"].waitForExistence(timeout: 10))
        capture("20-remove-history-preview")
        print("SHIYAN_QA_REMOVE_RESULT_AND_HISTORY_VISIBLE")
    }
    func testReopenPhotoHistory() throws {
        let app = XCUIApplication(bundleIdentifier: "com.shiyan.enhancer")
        app.launch()
        XCTAssertTrue(app.buttons["clock.arrow.circlepath"].waitForExistence(timeout: 25))
        app.buttons["clock.arrow.circlepath"].tap()
        for name in ["老照片上色", "AI 消除"] {
            let row = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label CONTAINS %@", "history-entry-", name)).firstMatch
            XCTAssertTrue(row.waitForExistence(timeout: 10), app.debugDescription)
            row.tap()
            let download = app.buttons["下载图片"]
            if !download.waitForExistence(timeout: 10) { print("HISTORY_PREVIEW_UI", app.debugDescription) }
            capture("history-preview-" + name)
            XCTAssertTrue(download.exists)
            app.buttons["关闭"].tap()
        }
        print("SHIYAN_QA_BOTH_HISTORY_PREVIEWS_PASSED")
    }

    func testMultiImageFollowUp() throws {
        let app = openChat()
        app.buttons["新建聊天"].tap()
        let field = input(app)
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        field.tap()
        field.typeText("Generate two separate images, not a collage: first a blue circle on white, second a green square on white. Return both image files.")
        sleep(1); app.buttons["发送"].tap()
        capture("21-multi-image-start")
         
        app.buttons["新建聊天"].tap()
        openSidebar(app)
        let row = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label BEGINSWITH %@", "session-row-", "Generate two")).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 12), app.debugDescription)
        let originalID = row.identifier
        capture("22-multi-image-background-chat")
        let unread = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            let target = app.buttons[originalID]
            return target.exists && (target.value as? String) == "有新内容"
        }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [unread], timeout: 500), .completed)
        capture("23-multi-image-unread")
        app.buttons[originalID].tap()
        let images = app.buttons["查看图片"]
        let imageList = app.buttons.matching(identifier: "查看图片")
        let multiple = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in imageList.count >= 2 && !app.buttons["停止处理"].exists }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [multiple], timeout: 240), .completed, app.debugDescription)
        capture("24-multi-image-results")
        print("SHIYAN_QA_MULTIPLE_IMAGES_AND_UNREAD_PASSED", imageList.count)
        imageList.element(boundBy: 0).press(forDuration: 1)
        XCTAssertTrue(app.buttons["使用这张图片"].waitForExistence(timeout: 8))
        app.buttons["使用这张图片"].tap()
        let edit = input(app)
        edit.tap(); edit.typeText("Change only the shape color in this attached image to red. Keep the same shape and white background.")
        sleep(1); app.buttons["发送"].tap()
        capture("25-selected-image-edit-start")
        let edited = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            !app.buttons["停止处理"].exists && app.buttons.matching(identifier: "查看图片").count >= 3
        }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [edited], timeout: 500), .completed, app.debugDescription)
        capture("26-selected-image-edit-result")
        print("SHIYAN_QA_SELECTED_RESULT_FOLLOW_UP_VISIBLE")
    }

    func testResumeMultipleAndEdit() throws {
        let app = openChat()
        let imageList = app.buttons.matching(identifier: "查看图片")
        let restored = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            imageList.count >= 2 && !app.buttons["停止处理"].exists
        }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [restored], timeout: 180), .completed, app.debugDescription)
        capture("27-multiple-results-restored")
        print("SHIYAN_QA_MULTIPLE_RESULTS_RESTORED", imageList.count)
        imageList.element(boundBy: 0).press(forDuration: 1.1)
        XCTAssertTrue(app.buttons["使用这张图片"].waitForExistence(timeout: 8))
        app.buttons["使用这张图片"].tap()
        let field = input(app)
        field.tap(); field.typeText("Change only the shape in the attached image to red. Keep its exact shape and the white background."); sleep(1)
        app.buttons["发送"].tap()
        capture("28-multiple-selected-edit-running")
        let edited = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            !app.buttons["停止处理"].exists && app.buttons.matching(identifier: "查看图片").count >= 4
        }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [edited], timeout: 240), .completed, app.debugDescription)
        capture("29-multiple-selected-edit-result")
        print("SHIYAN_QA_SELECTED_IMAGE_CONTINUATION_PASSED")
    }
    func testMessagesAndReasoning() throws {
        let app = openChat()
        app.buttons["新建聊天"].tap()
        let effort = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "推理档位：")).firstMatch
        effort.tap()
        XCTAssertTrue(app.staticTexts["reasoning-current-title"].waitForExistence(timeout: 8))
        let slider = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "推理档位")).firstMatch
        XCTAssertTrue(slider.waitForExistence(timeout: 6), app.debugDescription)
        slider.coordinate(withNormalizedOffset: CGVector(dx: 0.50, dy: 0.5)).tap()
        capture("30-reasoning-high-selected")
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.30)).tap()
        XCTAssertTrue(app.buttons["推理档位：高"].waitForExistence(timeout: 5), app.debugDescription)
        let field = input(app)
        field.tap(); field.typeText("只回复：中文完整输入测试通过"); sleep(1)
        print("QA_CHINESE_INPUT", field.value ?? "nil")
        app.buttons["发送"].tap()
        XCTAssertTrue(app.staticTexts["中文完整输入测试通过"].waitForExistence(timeout: 150), app.debugDescription)
        capture("31-chinese-text-high-reasoning")
        let user = app.staticTexts["只回复：中文完整输入测试通过"]
        user.press(forDuration: 1.1)
        XCTAssertTrue(app.buttons["编辑"].waitForExistence(timeout: 8), app.debugDescription)
        XCTAssertTrue(app.buttons["复制"].exists)
        capture("32-user-message-menu")
        app.buttons["编辑"].tap()
        XCTAssertTrue(app.staticTexts["编辑后重新发送"].waitForExistence(timeout: 5))
        capture("33-message-edit-draft")
        XCTAssertTrue(app.buttons["语音转文字"].exists)
        print("SHIYAN_QA_CHINESE_EDIT_COPY_REASONING_UI_PASSED")
    }


     
     
    func testBlankNewConversationShowsInRecentAndCanPin() throws {
        let app = XCUIApplication(bundleIdentifier: "com.shiyan.enhancer")
        app.launchEnvironment["SHIYAN_UI_TEST_OPEN_AGENT"] = "1"
        app.launchEnvironment["SHIYAN_UI_TEST_EDIT_BRANCH"] = "1"
        app.launch()
        let create = app.buttons["新建聊天"]
        XCTAssertTrue(create.waitForExistence(timeout: 25))
        create.tap()
        let send = app.buttons["发送"]
        XCTAssertTrue(send.waitForExistence(timeout: 4))
        XCTAssertFalse(send.isEnabled, "Empty messages must keep the send arrow disabled.")

        app.buttons["历史会话"].tap()
        XCTAssertTrue(app.staticTexts["最近"].waitForExistence(timeout: 6))
        let blank = app.buttons["新聊天"].firstMatch
        XCTAssertTrue(blank.waitForExistence(timeout: 6), "Empty conversation must appear in Recent.")
        blank.press(forDuration: 0.65)
        let pin = app.buttons["session-pin"]
        XCTAssertTrue(pin.waitForExistence(timeout: 4), "Empty conversation must be pinnable.")
        pin.tap()
        XCTAssertTrue(app.staticTexts["置顶"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["新聊天"].exists)
        capture("empty-session-appears-and-pins")
        print("SHIYAN_EMPTY_SESSION_IN_RECENT_PIN_AND_DISABLED_SEND_PASSED")
    }
}
