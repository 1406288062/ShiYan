import Foundation
import UIKit

 
 
@MainActor
enum ShiyanDeviceSmokeProbe {
    static func runIfRequested() async {
#if DEBUG
        guard ProcessInfo.processInfo.environment["SHIYAN_V2_DEVICE_SMOKE"] == "1" else { return }
        let output = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("v2-device-smoke.json")
        var result: [String: Any] = ["started": Date().timeIntervalSince1970, "device": UIDevice.current.model,
            "systemVersion": UIDevice.current.systemVersion, "passed": false]
        func persist() {
            guard let bytes = try? JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys]) else { return }
            try? bytes.write(to: output, options: .atomic)
        }
        persist()
        do {
            let capabilities = try await CodexClient.shared.capabilities()
            result["authenticatedCapabilities"] = true; result["model"] = capabilities.model; persist()
            let reply = try await CodexClient.shared.run(prompt: "Reply exactly SHIYAN_V2_DEVICE_OK",
                threadKey: "shiyan-v2-device-qa-" + UUID().uuidString)
            guard reply.text.trimmingCharacters(in: .whitespacesAndNewlines) == "SHIYAN_V2_DEVICE_OK" else {
                throw AgentClientError.message("真机文字链路未返回预期测试标记")
            }
            result["textRoundTrip"] = true; persist()
            let asset = try await CodexClient.shared.download(AgentRemoteAsset(
                id: "87169492-68e3-4794-af61-4c8fdbe7e2df", filename: "v2-device-image-check.jpg", mimeType: "image/jpeg", bytes: nil))
            guard let image = UIImage(contentsOfFile: asset.url.path)?.cgImage else { throw AgentClientError.message("真机结果图片无法解码") }
            result["authenticatedImageDownload"] = true
            result["imageWidth"] = image.width; result["imageHeight"] = image.height
            result["passed"] = true
        } catch { result["error"] = error.localizedDescription }
        result["finished"] = Date().timeIntervalSince1970; persist()
        NSLog("[ShiyanV2DeviceSmoke] passed=%@", result["passed"] as? Bool == true ? "YES" : "NO")
#endif
    }
}
