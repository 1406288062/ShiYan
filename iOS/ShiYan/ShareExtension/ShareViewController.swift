import UIKit
import Social

class ShareViewController: SLComposeServiceViewController {
    private var imageToEnhance: UIImage?

    override func viewDidLoad() {
        super.viewDidLoad()
        placeholder = "拾燕增强"
        textView.isHidden = true
        extractImage()
    }

    private func extractImage() {
        guard let item = extensionContext?.inputItems.first as? NSExtensionItem,
              let attachments = item.attachments else { return }
        for provider in attachments where provider.hasItemConformingToTypeIdentifier("public.image") {
            provider.loadDataRepresentation(forTypeIdentifier: "public.image") { [weak self] data, _ in
                if let d = data { self?.imageToEnhance = UIImage(data: d) }
            }
            break
        }
    }

    override func isContentValid() -> Bool { true }

    override func didSelectPost() {
        guard let img = imageToEnhance?.cgImage else {
            extensionContext?.completeRequest(returningItems: nil)
            return
        }
        let engine = ESRGANEngine()
        _ = engine.loadModel(.x4)
        Task {
            if let result = await engine.enhance(img, model: .x4, onProgress: { _ in }) {
                UIImageWriteToSavedPhotosAlbum(UIImage(cgImage: result), nil, nil, nil)
            }
            extensionContext?.completeRequest(returningItems: nil)
        }
    }

    override func configurationItems() -> [Any]! { [] }
}
