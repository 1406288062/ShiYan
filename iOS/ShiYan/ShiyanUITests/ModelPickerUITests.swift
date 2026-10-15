import XCTest

final class ModelPickerUITests: XCTestCase {
    override func setUp() { super.setUp(); continueAfterFailure = false }
    private func capture(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
    }
    func testModelSwitchDraftAndRunningRequest() {
        let app = XCUIApplication(bundleIdentifier: "com.shiyan.enhancer")
        app.launchEnvironment["SHIYAN_UI_TEST_OPEN_AGENT"] = "1"
        app.launchEnvironment["SHIYAN_UI_TEST_CHAT_REPAIR"] = "speech"
         
        app.launchEnvironment["SHIYAN_UI_TEST_MODELS"] = #"{"model":"gpt-6-luna","reasoningEfforts":["low","medium","high","xhigh","max"],"defaultReasoning":"low","maxUploadImages":8,"models":[{"id":"gpt-6.1-sol","displayName":"GPT-6.1-Sol","reasoningEfforts":["low","medium","high","xhigh","max","ultra"],"defaultReasoning":"low"},{"id":"gpt-6-luna","displayName":"GPT-6-Luna","reasoningEfforts":["low","medium","high","xhigh","max"],"defaultReasoning":"medium"}]}"#
        app.launchArguments = ["-AppleLanguages", "(zh-Hans)", "-AppleLocale", "zh_CN"]
        app.launch()
        let entry = app.buttons["agent-animated-small-gauge"]
        XCTAssertTrue(entry.waitForExistence(timeout: 30))
        XCTAssertTrue(entry.isHittable, "Model selection must work with the keyboard closed")
        capture("model-picker-01-collapsed")
        entry.tap()
        let picker = app.buttons["agent-model-picker"]
        XCTAssertTrue(picker.waitForExistence(timeout: 8))
        capture("model-picker-02-panel")
        picker.tap()
        capture("model-picker-03-options")
        app.buttons["agent-model-gpt-6.1-sol"].tap()
        XCTAssertTrue(picker.label.contains("GPT-6.1-Sol"))
        let track = app.otherElements["agent-reasoning-track"]
        XCTAssertTrue(track.exists, app.debugDescription)
        track.coordinate(withNormalizedOffset: CGVector(dx: 0.97, dy: 0.5)).tap()
        XCTAssertEqual(app.staticTexts["reasoning-current-title"].label, "极致")
        picker.tap(); app.buttons["agent-model-gpt-6-luna"].tap()
        XCTAssertEqual(app.staticTexts["reasoning-current-title"].label, "中", "Unsupported effort must use the new model default")
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.25)).tap()
        let input = app.textFields["agent-message-input"]
        input.tap(); input.typeText("模型切换保留草稿")
        capture("model-picker-04-expanded-draft")
        entry.tap(); picker.tap(); app.buttons["agent-model-gpt-6.1-sol"].tap()
        XCTAssertEqual(input.value as? String, "模型切换保留草稿")
        capture("model-picker-05-selected-with-draft")
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.25)).tap()
        app.buttons["发送"].tap()
        XCTAssertTrue(app.buttons["停止处理"].waitForExistence(timeout: 5))
        entry.tap(); picker.tap(); app.buttons["agent-model-gpt-6-luna"].tap()
        XCTAssertTrue(picker.label.contains("GPT-6-Luna"))
        capture("model-picker-06-next-turn-setting")
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.25)).tap()
        app.buttons["新建聊天"].tap()
        entry.tap()
        XCTAssertTrue(picker.label.contains("GPT-6-Luna"), "New conversation starts with the server default model")
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.25)).tap()
        app.buttons["历史会话"].tap()
        let previous = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "聊天回归测试")).firstMatch
        XCTAssertTrue(previous.waitForExistence(timeout: 5), app.debugDescription)
        previous.tap(); entry.tap()
        XCTAssertEqual(app.staticTexts["reasoning-current-title"].label, "中", "Conversation reasoning is restored")
        capture("model-picker-07-conversation-restored")
    }
}
