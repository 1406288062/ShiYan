import XCTest

final class UXRevisionUITests: XCTestCase {
    override func setUp() { super.setUp(); continueAfterFailure = false }
    private func app(chat: Bool = true) -> XCUIApplication {
        let app = XCUIApplication(bundleIdentifier: "com.shiyan.enhancer")
        if chat { app.launchEnvironment["SHIYAN_UI_TEST_OPEN_AGENT"] = "1" }
        app.launch()
        XCTAssertTrue((chat ? app.buttons["新建聊天"] : app.buttons["AI Agent"]).waitForExistence(timeout: 25), app.debugDescription)
        return app
    }
    private func capture(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
    }
    private func drag(_ app: XCUIApplication, from: CGVector, to: CGVector) {
        app.coordinate(withNormalizedOffset: from).press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: to), withVelocity: .slow, thenHoldForDuration: 0)
    }
    private func sidebar(_ app: XCUIApplication) {
        app.buttons["历史会话"].tap()
        XCTAssertTrue(app.buttons["搜索会话"].waitForExistence(timeout: 8))
    }
    private func input(_ app: XCUIApplication) -> XCUIElement { app.textFields["agent-message-input"] }
    private func select(_ title: String, in app: XCUIApplication) {
        sidebar(app)
        let row = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label == %@", "session-row-", title)).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 8), app.debugDescription); row.tap()
    }

    func test01ComposerHeaderDrawerSearchAndDelete() throws {
        let app = app()
        app.buttons["新建聊天"].tap()
        let gauge = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "推理档位：")).firstMatch
        XCTAssertTrue(gauge.exists, "输入框的小圆图标应始终显示")
        let field = input(app); XCTAssertTrue(field.waitForExistence(timeout: 5))
        capture("01-chat-compact-header")
        let oldFrame = field.frame
        field.tap()
        XCTAssertTrue(gauge.waitForExistence(timeout: 6), app.debugDescription)
        field.typeText("Line one\nLine two\nLine three\nLine four")
        capture("02-chat-expanded-keyboard")
        XCTAssertGreaterThan(field.frame.height, oldFrame.height + 30)
        if app.keyboards.firstMatch.exists {
            XCTAssertLessThan(field.frame.maxY, app.keyboards.firstMatch.frame.minY + 2)
        }
        gauge.tap(); XCTAssertTrue(app.staticTexts["reasoning-current-title"].waitForExistence(timeout: 5))
        capture("03-reasoning-low")
        let slider = app.otherElements.matching(NSPredicate(format: "label == %@", "推理档位")).firstMatch
        if slider.exists {
            slider.coordinate(withNormalizedOffset: CGVector(dx: 0.97, dy: 0.5)).tap()
        } else {
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.85, dy: 0.86)).tap()
        }
        capture("04-reasoning-high")
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.50, dy: 0.28)).tap()
        app.buttons["新建聊天"].tap()
        app.buttons["新建聊天"].tap()
        sidebar(app)
        XCTAssertEqual(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label == %@", "session-row-", "新聊天")).count, 0)
        capture("05-sidebar-alignment")
        let existingRow = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "session-row-")).firstMatch
        XCTAssertTrue(existingRow.waitForExistence(timeout: 5))
        let existingTitle = existingRow.label
        let search = app.buttons["搜索会话"]; search.tap()
        XCTAssertTrue(app.textFields["session-search"].waitForExistence(timeout: 8))
        XCTAssertTrue(app.buttons["关闭搜索"].exists)
        capture("06-fullscreen-search-recent")
        app.textFields["session-search"].tap(); app.textFields["session-search"].typeText(String(existingTitle.prefix(5)))
        let result = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "search-result-")).firstMatch
        XCTAssertTrue(result.waitForExistence(timeout: 5)); capture("07-search-matching-message")
        app.buttons["关闭搜索"].tap()
        let target = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label == %@", "session-row-", existingTitle)).firstMatch
        XCTAssertTrue(target.waitForExistence(timeout: 5)); target.press(forDuration: 0.8)
        XCTAssertTrue(app.buttons["删除"].waitForExistence(timeout: 5)); capture("08-session-preview-menu")
        app.buttons["删除"].tap()
        let confirm = app.buttons["confirm-delete-conversation"]
        XCTAssertTrue(confirm.waitForExistence(timeout: 6), app.debugDescription)
        capture("09-sidebar-delete-confirmation")
         
        let sidebarWidth = app.windows.firstMatch.frame.width * 0.75
        XCTAssertEqual(confirm.frame.midX, sidebarWidth / 2, accuracy: 10)
        XCTAssertLessThanOrEqual(confirm.frame.maxX, sidebarWidth + 1)
        XCTAssertGreaterThanOrEqual(confirm.frame.minX, 0)
         
        XCTAssertTrue(confirm.frame.maxY <= target.frame.minY + 6 ||
                      confirm.frame.minY >= target.frame.maxY - 6)
        app.buttons["cancel-delete-conversation"].tap()
        XCTAssertTrue(target.exists)
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.94, dy: 0.45)).tap()
        for x in [0.12, 0.36, 0.61] {
            drag(app, from: CGVector(dx: x, dy: 0.42), to: CGVector(dx: min(0.97, x + 0.34), dy: 0.43))
            XCTAssertTrue(app.buttons["搜索会话"].waitForExistence(timeout: 5))
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.46)).tap()
        }
        print("UX_COMPOSER_DRAWER_SEARCH_DELETE_PASSED")
    }

    func test02ExistingImageRecoveryAndGenericText() throws {
        let app = app()
        app.buttons["新建聊天"].tap()
        let prompt = input(app); prompt.tap()
        prompt.typeText("Generate one image: a blue circle on a plain white background.")
        app.buttons["发送"].tap()
        let image = app.buttons["查看图片"].firstMatch
        XCTAssertTrue(image.waitForExistence(timeout: 90), app.debugDescription)
        capture("10-recovered-real-server-image")
        image.tap()
        XCTAssertTrue(app.buttons["保存图片"].waitForExistence(timeout: 8))
        capture("11-recovered-image-preview")
        app.buttons["关闭"].tap()
        app.buttons["新建聊天"].tap()
        let field = input(app); field.tap(); field.typeText("Reply exactly UX_TEXT_OK_1008")
        app.buttons["发送"].tap()
        capture("12-thinking-after-send")
        let reply = app.staticTexts["UX_TEXT_OK_1008"]
        XCTAssertTrue(reply.waitForExistence(timeout: 65), app.debugDescription)
        capture("13-generic-codex-reply")
        app.terminate(); app.launch()
        XCTAssertTrue(app.staticTexts["UX_TEXT_OK_1008"].waitForExistence(timeout: 20))
        capture("14-conversation-persisted")
        print("UX_REAL_IMAGE_RECOVERY_TEXT_PERSISTENCE_PASSED")
    }

    func test03StopHasImmediateEffect() throws {
        let app = app(); app.buttons["新建聊天"].tap()
        let field = input(app); field.tap()
        field.typeText("Generate an original image of a blue circle on white. Return the image.")
        app.buttons["发送"].tap()
        let stop = app.buttons["停止处理"]
        XCTAssertTrue(stop.waitForExistence(timeout: 5))
        capture("15-before-stop")
        let start = Date(); stop.tap()
        let stopped = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "停止")).firstMatch
        XCTAssertTrue(stopped.waitForExistence(timeout: 3))
        XCTAssertFalse(app.buttons["停止处理"].exists)
        XCTAssertTrue(app.buttons["发送"].exists)
        capture("16-stopped-ui-immediate")
        print("UX_STOP_UI_SECONDS", Date().timeIntervalSince(start))
        XCTAssertTrue(app.staticTexts["已停止"].waitForExistence(timeout: 12), app.debugDescription)
        capture("17-stop-server-confirmation")
        XCTAssertFalse(app.staticTexts["服务器停止尚未确认，恢复连接后将重试"].exists)
        print("UX_STOP_IMMEDIATE_AND_ACK_PASSED")
    }

    func test04HomeGridAndAlignedPhotoControls() throws {
        let app = app(chat: false)
        capture("18-home-aligned-light")
        XCTAssertEqual(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "feature-")).count, 4)
        app.buttons["clock.arrow.circlepath"].tap()
        XCTAssertTrue(app.staticTexts["历史记录"].waitForExistence(timeout: 7))
        app.buttons["More"].tap(); app.buttons["网格"].tap()
        capture("19-history-grid-no-badges")
        app.buttons["More"].tap(); app.buttons["选择"].tap()
        capture("20-grid-selection-white-and-dark")
        let cards = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "history-entry-"))
        XCTAssertGreaterThanOrEqual(cards.count, 2)
        cards.element(boundBy: 0).tap()
        capture("21-grid-selected-state")
        print("UX_HOME_GRID_PASSED")
    }

    func test05ColorizeStopLayoutAndCancellation() throws {
        let app = XCUIApplication(bundleIdentifier: "com.shiyan.enhancer")
        app.launchEnvironment["SHIYAN_UI_TEST_IMAGE"] = "ux-gray.jpg"; app.launch()
        XCTAssertTrue(app.buttons["老照片上色"].waitForExistence(timeout: 25))
        app.buttons["feature-老照片上色"].tap()
        app.buttons["开始上色"].tap()
        let stop = app.buttons["取消"]
        XCTAssertTrue(stop.waitForExistence(timeout: 5))
        let primary = app.buttons["photo-start-colorize"]
        XCTAssertTrue(primary.exists)
        XCTAssertGreaterThan(stop.frame.midX, primary.frame.midX)
        XCTAssertEqual(stop.frame.midY, primary.frame.midY, accuracy: 3)
        capture("22-colorize-stop-on-right")
        stop.tap(); XCTAssertTrue(app.buttons["开始上色"].waitForExistence(timeout: 5))
        capture("23-colorize-cancelled")
        print("UX_PHOTO_STOP_ALIGNMENT_PASSED")
    }
    func test06RealPhotoResultsAndHistory() throws {
        for feature in ["老照片上色", "AI 消除"] {
            let app = XCUIApplication(bundleIdentifier: "com.shiyan.enhancer")
            app.launchEnvironment["SHIYAN_UI_TEST_IMAGE"] = feature == "老照片上色" ? "ux-gray.jpg" : "ux-remove.jpg"
            app.launch()
            let item = app.buttons["feature-" + feature]
            XCTAssertTrue(item.waitForExistence(timeout: 25)); item.tap()
            if feature == "AI 消除" {
                let canvas = app.otherElements["removal-canvas"]
                XCTAssertTrue(canvas.waitForExistence(timeout: 8))
                for y in [0.43, 0.49, 0.55, 0.61] {
                    canvas.coordinate(withNormalizedOffset: CGVector(dx: 0.40, dy: y)).press(forDuration: 0.05,
                        thenDragTo: canvas.coordinate(withNormalizedOffset: CGVector(dx: 0.60, dy: y)))
                }
            }
            let start = app.buttons[feature == "老照片上色" ? "photo-start-colorize" : "photo-start-remove"]
            XCTAssertTrue(start.exists); start.tap()
            let stop = app.buttons["取消"]
            XCTAssertTrue(stop.waitForExistence(timeout: 5))
            XCTAssertGreaterThan(stop.frame.midX, start.frame.midX)
            XCTAssertEqual(stop.frame.midY, start.frame.midY, accuracy: 3)
            capture("24-" + feature + "-processing-stop-aligned")
            XCTAssertTrue(app.buttons["保存结果"].waitForExistence(timeout: 120), app.debugDescription)
            capture("25-" + feature + "-real-result")
            app.buttons["clock.arrow.circlepath"].tap()
            let entry = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label CONTAINS %@", "history-entry-", feature)).firstMatch
            XCTAssertTrue(entry.waitForExistence(timeout: 8)); entry.tap()
            XCTAssertTrue(app.buttons["下载图片"].waitForExistence(timeout: 8))
            capture("26-" + feature + "-history-preview")
            print("UX_REAL_PHOTO_HISTORY_PASSED", feature)
        }
    }
    func test07ActualReasoningAndEdgeScroll() throws {
        let app = app(); app.buttons["新建聊天"].tap()
        let field = input(app); field.tap()
        let gauge = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "推理档位：")).firstMatch
        XCTAssertTrue(gauge.waitForExistence(timeout: 5)); gauge.tap()
        let slider = app.otherElements.matching(NSPredicate(format: "label == %@", "推理档位")).firstMatch
        XCTAssertTrue(slider.waitForExistence(timeout: 5), app.debugDescription)
        slider.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        XCTAssertEqual(app.staticTexts["reasoning-current-title"].label, "高")
        capture("27-reasoning-selected-high")
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.28)).tap()
        field.tap(); field.typeText("Reply exactly UX_HIGH_OK")
        capture("28-gauge-high-filled")
        app.buttons["发送"].tap()
        XCTAssertTrue(app.staticTexts["UX_HIGH_OK"].waitForExistence(timeout: 60), app.debugDescription)
        capture("29-high-reasoning-real-reply")
        sidebar(app)
        drag(app, from: CGVector(dx: 0.42, dy: 0.73), to: CGVector(dx: 0.42, dy: 0.26))
        capture("30-sidebar-gradual-top-fade")
        print("UX_REASONING_HIGH_AND_EDGE_SCROLL_PASSED")
    }


    func test08SidebarVisualParityAndLongPressClipping() throws {
        let app = app()
        let opener = app.buttons["历史会话"]
        let compose = app.buttons["新建聊天"]
        let exit = app.buttons["关闭聊天"]
        XCTAssertTrue(opener.exists && compose.exists && exit.exists)
        for control in [opener, compose, exit] {
            XCTAssertEqual(control.frame.width, 46, accuracy: 1.5)
            XCTAssertEqual(control.frame.height, 46, accuracy: 1.5)
        }
        capture("31-header-unified-46pt-white-chat")
        sidebar(app)
        let search = app.buttons["搜索会话"]
        XCTAssertEqual(search.frame.width, 46, accuracy: 1.5)
        XCTAssertEqual(search.frame.height, 46, accuracy: 1.5)
        capture("32-grey-sidebar-white-chat-soft-left-edge")
        let row = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "session-row-")).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 8), app.debugDescription)
        let divider = app.windows.firstMatch.frame.width * 0.75
        XCTAssertLessThanOrEqual(row.frame.maxX, divider + 1)
        let id = row.identifier
        let initiallyPinned = (row.value as? String ?? "").contains("已置顶")
        let initiallySelected = (row.value as? String ?? "").contains("当前会话")
        row.press(forDuration: 0.9)
        let delete = app.buttons["删除"]
        XCTAssertTrue(delete.waitForExistence(timeout: 6), app.debugDescription)
        XCTAssertLessThanOrEqual(delete.frame.maxX, divider + 1, "Menu action crossed sidebar boundary")
        let menu = app.descendants(matching: .any)["conversation-actions-menu"].firstMatch
        if menu.exists {
            XCTAssertGreaterThanOrEqual(menu.frame.minX, -1)
            XCTAssertLessThanOrEqual(menu.frame.maxX, divider + 1, "Menu glass crossed sidebar boundary")
        }
        capture("33-context-menu-no-overflow-rectangle")
        let toggle = app.buttons[initiallyPinned ? "取消置顶" : "置顶"]
        XCTAssertTrue(toggle.exists)
         
         
         
        XCTAssertEqual((row.value as? String ?? "").contains("当前会话"), initiallySelected)
        app.buttons["关闭会话菜单"].tap()
        XCTAssertTrue(app.buttons[id].exists)
        capture("34-custom-menu-dismissed-no-phantom-tap")
        print("UX_SIDEBAR_COLOR_ICON_LONGPRESS_PASSED")
    }
     
     
    func test09ComposerSmallRingActuallyAnimates() throws {
        let app = app()
        let gauge = app.buttons["agent-animated-small-gauge"]
        XCTAssertTrue(gauge.waitForExistence(timeout: 8), app.debugDescription)
        XCTAssertEqual(gauge.frame.width, 40, accuracy: 2)
        XCTAssertEqual(gauge.frame.height, 40, accuracy: 2)
        let x = gauge.frame
        XCTAssertLessThan(x.maxX, app.frame.maxX - 76)
        func pixels() -> [UInt8] {
            let shot = XCUIScreen.main.screenshot().image
            guard let cg = shot.cgImage else { return [] }
            let scale = CGFloat(cg.width) / app.frame.width
             
            let rect = x.insetBy(dx: 7, dy: 7)
            let crop = CGRect(x: rect.minX * scale, y: rect.minY * scale,
                              width: rect.width * scale, height: rect.height * scale).integral
            guard let part = cg.cropping(to: crop) else { return [] }
            var result = [UInt8](repeating: 0, count: part.width * part.height * 4)
            guard let ctx = CGContext(data: &result, width: part.width,
                                      height: part.height, bitsPerComponent: 8,
                                      bytesPerRow: part.width * 4,
                                      space: CGColorSpaceCreateDeviceRGB(),
                                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue |
                                                  CGBitmapInfo.byteOrder32Big.rawValue) else { return [] }
            ctx.draw(part, in: CGRect(x: 0, y: 0, width: part.width, height: part.height))
            return result
        }
        let first = pixels()
        XCTAssertGreaterThan(first.count, 500)
        capture("35-small-ring-initial")
        Thread.sleep(forTimeInterval: 0.43)
        let second = pixels()
        capture("36-small-ring-after-430ms")
        Thread.sleep(forTimeInterval: 0.49)
        let third = pixels()
        capture("37-small-ring-after-920ms")
        XCTAssertEqual(first.count, second.count)
        XCTAssertEqual(first.count, third.count)
        let different = zip(first, second).filter { abs(Int($0.0) - Int($0.1)) > 12 }.count
        let different2 = zip(first, third).filter { abs(Int($0.0) - Int($0.1)) > 12 }.count
        let different3 = zip(second, third).filter { abs(Int($0.0) - Int($0.1)) > 12 }.count
        print("SHIYAN_SMALL_RING_FRAME_CHANGES",different,different2,different3)
        XCTAssertGreaterThan(max(different, different2, different3), 18,
                             "Small input ring must visibly animate over time")
        gauge.tap()
        XCTAssertTrue(app.staticTexts["reasoning-current-title"].waitForExistence(timeout: 6),
                      "Animated gauge must retain real reasoning-level control")
        print("SHIYAN_SMALL_RING_ANIMATION_AND_CONTROL_PASSED")
    }

}
