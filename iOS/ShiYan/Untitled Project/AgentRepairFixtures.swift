#if DEBUG
import Foundation
import UIKit

 
enum AgentRepairFixtures {
    static let userText = "这是一条有文字的用户消息。滚动到图片下方时，这段文字也必须完整可见。长按后应能复制、编辑和选择其中一部分文字。"
    static let assistantText = "这段回复用于验证原生文字选择。长按任意一个词，直接拖动选择范围，再使用复制或全选。\n\n文字没有额外颜色、玻璃遮罩、放大或弹跳效果。"
    static let speechLong = "请帮我画一幅安静的书房插画，窗外有阳光，桌上放着一本打开的书，整体采用自然柔和的颜色。"
    static let speechCorrected = "请为我画一幅安静的书房插画，窗外有阳光，桌上放着一本打开的书，整体采用自然柔和的颜色。"
    static let speechTail = "再加上一只趴在窗边的小猫。"
    struct SpeechSample { var text: String; var start: Double; var end: Double; var final = false }
     
     
     
    static var longSpeechPhrases: [String] {
        (1...60).map { "第\($0)段语音请保持先后顺序，继续补充故事的风景人物动作与细节。" }
    }
    static var longSpeechExpected: String { longSpeechPhrases.joined() }
    static var speechSamples: [SpeechSample] { [
        .init(text: "请帮我画一幅插画", start: 0.2, end: 1.2),
        .init(text: speechLong, start: 0.2, end: 7.0),
        .init(text: speechCorrected, start: 0.3, end: 7.2),
        .init(text: speechCorrected, start: 0.25, end: 7.2),
        .init(text: speechTail, start: 10.0, end: 13.0),
        .init(text: speechTail, start: 10.0, end: 13.0),
        .init(text: speechCorrected + speechTail, start: 0.2, end: 13.0, final: true)
    ] }
    static func conversation() -> AgentConversation {
        let scenario = ProcessInfo.processInfo.environment["SHIYAN_UI_TEST_CHAT_REPAIR"] ?? "render"
        var item = AgentConversation(); item.title = "聊天回归测试"; item.titleIsManual = true
        if scenario == "speech" || scenario == "speech-long" { return item }
        if scenario == "scroll" {
            for i in 1...12 {
                item.messages.append(AgentMessage(role: .user, text: "历史消息第\(i)条"))
                item.messages.append(AgentMessage(role: .assistant, text: "历史回复第\(i)条：浏览历史时，新回复不应抢走滚动位置。"))
            }
            return item
        }
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: 580, height: 320))
        let image = renderer.image { context in
            UIColor.systemIndigo.withAlphaComponent(0.2).setFill(); context.fill(CGRect(x: 0, y: 0, width: 580, height: 320))
            UIColor.systemTeal.setFill(); context.fill(CGRect(x: 28, y: 26, width: 240, height: 268))
            ("图片下方文字清晰度测试" as NSString).draw(at: CGPoint(x: 280, y: 140), withAttributes: [.font: UIFont.systemFont(ofSize: 17), .foregroundColor: UIColor.label])
        }
        var upload = try! AgentMedia.saveImage(image)
        var generated = try! AgentMedia.saveImage(image); generated.remoteID = "fixture-generated-current-turn"
        let bubbleText = scenario == "preview-short" ? "长得像哪个明星"
            : scenario == "preview-1000" ? "输出1000字小说" : userText
        var user = AgentMessage(role: .user, text: bubbleText, assets: [upload])
        user.id = UUID(uuidString: "11111111-1111-1111-1111-111111111111")!
        var reply = AgentMessage(role: .assistant, text: assistantText)
        reply.id = UUID(uuidString: "22222222-2222-2222-2222-222222222222")!
        if scenario == "image-valid" {
            reply.assets = [generated]
            reply.text = "图片生成没有返回可展示的结果。你可以再发一次。"
        } else if scenario == "image-missing" {
            generated.relativePath = "fixture-nonexistent.png"
            reply.assets = [generated]
            reply.text = "图片生成没有返回可展示的结果。你可以再发一次。"
        } else if scenario == "image-upload" {
            reply.text = "图片生成没有返回可展示的结果。你可以再发一次。"
        } else {
            reply.assets = [generated]
        }
        item.messages = [
            AgentMessage(role: .user, text: "较早的消息，用于检查滚动经过顶部时不会抹掉后续文字。"),
            AgentMessage(role: .assistant, text: String(repeating: "这是一段较早的回复，正文一直保持清楚可读。\n", count: 6)),
            user, reply
        ]
        return item
    }
}
#endif
