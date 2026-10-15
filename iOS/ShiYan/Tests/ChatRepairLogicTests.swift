import Foundation

@main
enum ChatRepairLogicTests {
    static func main() {
        var passed = 0
        func equal(_ actual: String, _ expected: String, _ name: String) {
            guard actual == expected else { fputs("FAIL \(name): [\(actual)] != [\(expected)]\n", stderr); exit(1) }
            passed += 1; print("PASS \(name)")
        }
        let first = "请帮我画一幅安静的书房插画，窗外有阳光，桌上放着一本打开的书，整体采用自然柔和的颜色。"
        let corrected = "请为我画一幅安静的书房插画，窗外有阳光，桌上放着一本打开的书，整体采用自然柔和的颜色。"
        let tail = "再加上一只趴在窗边的小猫。"
        var a = SpeechTranscriptAccumulator()
        equal(a.accept("请帮我画", firstSegmentTime: 0.2, lastSegmentEndTime: 1), "请帮我画", "one-line partial")
        equal(a.accept(first, firstSegmentTime: 0.2, lastSegmentEndTime: 7), first, "multi-line cumulative result")
        equal(a.accept(corrected, firstSegmentTime: 0.3, lastSegmentEndTime: 7.2), corrected, "early-word correction must REPLACE not append")
        equal(a.accept(corrected, firstSegmentTime: 0.25, lastSegmentEndTime: 7.2), corrected, "timestamp revision duplicate")
        equal(a.accept(tail, firstSegmentTime: 10, lastSegmentEndTime: 13), corrected + tail, "pause appends a disjoint audio range")
        equal(a.accept(tail, firstSegmentTime: 10, lastSegmentEndTime: 13), corrected + tail, "new range duplicate callback")
        equal(a.accept(corrected + tail, firstSegmentTime: 0.2, lastSegmentEndTime: 13, isFinal: true), corrected + tail, "final cumulative output does not repeat either phrase")
        equal(a.accept("", firstSegmentTime: 0, lastSegmentEndTime: 0), corrected + tail, "empty callback preserves draft")
        equal("已有草稿：" + a.text, "已有草稿：" + corrected + tail, "existing typed text stays once")
        a.reset()
        equal(a.accept("你好", firstSegmentTime: 0.2, lastSegmentEndTime: 1), "你好", "first real utterance")
        equal(a.accept("你好", firstSegmentTime: 2, lastSegmentEndTime: 3), "你好你好", "genuine spoken repetition retained")
        equal(a.accept("你好", firstSegmentTime: 2, lastSegmentEndTime: 3), "你好你好", "duplicate of second utterance not third repetition")
        a.reset()
        equal(a.accept("打开书房的灯", firstSegmentTime: 0.2, lastSegmentEndTime: 3), "打开书房的灯", "first hypothesis")
        equal(a.accept("关闭书房的灯", firstSegmentTime: 0.2, lastSegmentEndTime: 3.1), "关闭书房的灯", "no common prefix correction of same audio")
        equal(a.accept("关闭书房", firstSegmentTime: 0.2, lastSegmentEndTime: 3.1), "关闭书房的灯", "short partial does not flash deletion")
        equal(a.accept("关闭书房", firstSegmentTime: 0.2, lastSegmentEndTime: 3.1, isFinal: true), "关闭书房", "final correction is authoritative")
        a.reset()
        equal(a.accept("早先的句子", firstSegmentTime: 4, lastSegmentEndTime: 5), "早先的句子", "ordered current audio")
        equal(a.accept("过期回调", firstSegmentTime: 0, lastSegmentEndTime: 1), "早先的句子", "out-of-order old interval ignored")
        let missing = "图片生成没有返回可展示的结果。你可以再发一次。"
        equal(AgentResultPresentation.text(missing, hasVerifiedOutputImage: true), "图片已生成。", "current verified image wins over stale fallback")
        equal(AgentResultPresentation.text(missing, hasVerifiedOutputImage: false), missing, "upload or missing local image does not count as success")
        equal(AgentResultPresentation.text("正常描述\n\n" + missing, hasVerifiedOutputImage: true), "正常描述\n\n图片已生成。", "unrelated response preserved")
        equal(AgentResultPresentation.text("图片下载失败", hasVerifiedOutputImage: true), "图片下载失败", "do not suppress other failures")
        equal(AgentResultPresentation.error(missing, hasVerifiedOutputImage: true) ?? "nil", "nil", "contradictory fallback error removed only after verified output")
        equal(AgentResultPresentation.error("后续工具超时", hasVerifiedOutputImage: true) ?? "", "图片已收到，但后续处理未完成：后续工具超时", "real partial failure remains explicit")
        equal(AgentResultPresentation.error("鉴权失败", hasVerifiedOutputImage: false) ?? "", "鉴权失败", "nonimage failure unchanged")
        print("ALL \(passed) CHAT REPAIR LOGIC ASSERTIONS PASSED")
    }
}
