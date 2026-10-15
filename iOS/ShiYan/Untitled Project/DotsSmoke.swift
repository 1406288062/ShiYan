import Foundation

 
@MainActor
enum DotsSmoke {
    static func runIfRequested() async {
#if DEBUG
        guard let text = ProcessInfo.processInfo.environment["SHIYAN_DOTS_SMOKE_GOAL"], let goalId = Int(text), goalId > 0 else { return }
        let file = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("shiyan-dots-smoke.json")
        var result: [String: Any] = ["goalId": goalId, "source": "native-CodexClient-device-signature-pinned-TLS"]
        do {
            let capabilities = try await CodexClient.shared.dotsRead("capabilities", as: DotsCapabilities.self)
            let detail = try await CodexClient.shared.dotsRead("goals/\(goalId)", as: DotsDetail.self)
            let batch = try await CodexClient.shared.dotsRead("notifications?after=0&limit=10", as: DotsEventBatch.self)
            result["ok"] = detail.goal.id == goalId && capabilities.available == true
            result["status"] = detail.goal.status ?? ""
            result["eventCount"] = batch.events.count
            result["instructionCount"] = (detail.merged.events ?? []).filter { $0.type == "user_instruction" }.count
        } catch { result["ok"] = false; result["error"] = error.localizedDescription }
        if let data = try? JSONSerialization.data(withJSONObject: result, options: .prettyPrinted) { try? data.write(to: file, options: .atomic) }
#endif
    }
}
