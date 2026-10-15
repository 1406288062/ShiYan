import SwiftUI
import UIKit

 
 
struct AgentSelectableText: UIViewRepresentable {
    let text: String
    var markdown = false
    var monospaced = false
    var headingLevel = 0
    var textAlignment: NSTextAlignment = .natural
    var selectOnAppear = false
    var selectionRequestID = 0
    var identifier = ""
    var onSelectionChanged: ((Bool) -> Void)?
    @Environment(\.sizeCategory) private var sizeCategory

    func makeCoordinator() -> Coordinator { Coordinator() }
    func makeUIView(context: Context) -> SelectionTextView {
        let view = SelectionTextView()
        view.backgroundColor = .clear
        view.isOpaque = false
        view.isEditable = false
        view.isSelectable = true
        view.isScrollEnabled = false
        view.showsVerticalScrollIndicator = false
        view.showsHorizontalScrollIndicator = false
        view.textContainerInset = .zero
        view.textContainer.lineFragmentPadding = 0
        view.adjustsFontForContentSizeCategory = true
        view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        view.delegate = context.coordinator
        view.accessibilityIdentifier = identifier
        return view
    }
    func updateUIView(_ view: SelectionTextView, context: Context) {
        context.coordinator.onSelectionChanged = onSelectionChanged
        let style: UIFont.TextStyle = headingLevel == 1 ? .title2 : headingLevel == 2 ? .title3 : .body
        let base = UIFont.preferredFont(forTextStyle: style)
        let font = monospaced
            ? UIFont.monospacedSystemFont(ofSize: UIFont.preferredFont(forTextStyle: .footnote).pointSize, weight: .regular)
            : headingLevel > 0 ? UIFont(descriptor: base.fontDescriptor.withSymbolicTraits(.traitBold) ?? base.fontDescriptor, size: base.pointSize) : base
        let key = "\(text)\u{0}\(font.pointSize)-\(markdown)-\(monospaced)-\(headingLevel)-\(textAlignment.rawValue)"
        if context.coordinator.renderKey != key {
            let selection = view.selectedRange
            UIView.performWithoutAnimation {
                view.attributedText = Self.attributed(text, font: font, markdown: markdown, alignment: textAlignment)
                if selection.length > 0 {
                    let length = view.attributedText.length
                    let start = min(selection.location, length)
                    view.selectedRange = NSRange(location: start, length: min(selection.length, length - start))
                }
                view.invalidateIntrinsicContentSize()
            }
            context.coordinator.renderKey = key
        }
        view.accessibilityIdentifier = identifier
        if selectOnAppear && context.coordinator.lastSelectionRequest != selectionRequestID {
            context.coordinator.lastSelectionRequest = selectionRequestID
            view.requestSelection()
        }
    }
    func sizeThatFits(_ proposal: ProposedViewSize, uiView: SelectionTextView, context: Context) -> CGSize? {
        guard let width = proposal.width, width.isFinite, width > 0 else { return nil }
        let size = uiView.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude))
        return CGSize(width: width, height: ceil(size.height))
    }
    private static func attributed(_ text: String, font: UIFont, markdown: Bool, alignment: NSTextAlignment) -> NSAttributedString {
        let parsed = markdown
            ? (try? AttributedString(markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
            : nil
        let value = NSMutableAttributedString(attributedString: parsed.map { NSAttributedString($0) } ?? NSAttributedString(string: text))
        let range = NSRange(location: 0, length: value.length)
        let paragraph = NSMutableParagraphStyle(); paragraph.lineSpacing = 5; paragraph.alignment = alignment
        value.addAttributes([.font: font, .foregroundColor: UIColor.label, .paragraphStyle: paragraph], range: range)
         
        if let parsed {
            var offset = 0
            for run in parsed.runs {
                let part = String(parsed[run.range].characters)
                let span = NSRange(location: offset, length: (part as NSString).length)
                var traits: UIFontDescriptor.SymbolicTraits = font.fontDescriptor.symbolicTraits
                if run.inlinePresentationIntent?.contains(.stronglyEmphasized) == true { traits.insert(.traitBold) }
                if run.inlinePresentationIntent?.contains(.emphasized) == true { traits.insert(.traitItalic) }
                if run.inlinePresentationIntent?.contains(.code) == true {
                    value.addAttribute(.font, value: UIFont.monospacedSystemFont(ofSize: font.pointSize, weight: .regular), range: span)
                } else if !traits.isEmpty, let descriptor = font.fontDescriptor.withSymbolicTraits(traits) {
                    value.addAttribute(.font, value: UIFont(descriptor: descriptor, size: font.pointSize), range: span)
                }
                offset += span.length
            }
        }
        return value
    }
    final class SelectionTextView: UITextView {
        private var selectionWork: DispatchWorkItem?
        private var pendingSelection = false
        func requestSelection() {
            selectionWork?.cancel()
            pendingSelection = true
            let work = DispatchWorkItem { [weak self] in
                guard let self, self.pendingSelection, self.window != nil else { return }
                self.pendingSelection = false
                self.becomeFirstResponder()
                 
                self.selectedRange = NSRange(location: 0, length: 0)
                self.selectAll(nil)
            }
            selectionWork = work
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.2, execute: work)
        }
        override func didMoveToWindow() {
            super.didMoveToWindow()
            if window == nil { selectionWork?.cancel() }
            else if pendingSelection { requestSelection() }
        }
        override func copy(_ sender: Any?) {
            super.copy(sender)
#if DEBUG
            if ProcessInfo.processInfo.environment["SHIYAN_UI_TEST_CHAT_REPAIR"] != nil {
                let record: [String: Any] = ["identifier": accessibilityIdentifier ?? "", "range": [selectedRange.location, selectedRange.length], "fullLength": (text as NSString).length, "copied": UIPasteboard.general.string ?? "", "time": Date().timeIntervalSince1970]
                let url = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("chat-repair-selection-copy.json")
                if let data = try? JSONSerialization.data(withJSONObject: record) { try? data.write(to: url, options: .atomic) }
                let log = url.deletingLastPathComponent().appendingPathComponent("chat-repair-selection-copies.json")
                var records = (try? Data(contentsOf: log)).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [[String: Any]] } ?? []
                records.append(record)
                if let data = try? JSONSerialization.data(withJSONObject: Array(records.suffix(30))) { try? data.write(to: log, options: .atomic) }
            }
#endif
        }
        override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
            if action == #selector(copy(_:)) { return selectedRange.length > 0 }
            if action == #selector(selectAll(_:)) || action == #selector(select(_:)) { return !text.isEmpty }
            return false
        }
    }
    final class Coordinator: NSObject, UITextViewDelegate {
        var renderKey = ""
        var lastSelectionRequest: Int?
        var selectionActive = false
        var onSelectionChanged: ((Bool) -> Void)?
        func textViewDidChangeSelection(_ textView: UITextView) {
            let active = textView.selectedRange.length > 0
            guard active != selectionActive else { return }
            selectionActive = active
            DispatchQueue.main.async { [weak self] in self?.onSelectionChanged?(active) }
        }
        func textView(_ textView: UITextView, editMenuForTextIn range: NSRange, suggestedActions: [UIMenuElement]) -> UIMenu? {
            selectionMenu(textView)
        }
        func textView(_ textView: UITextView, editMenuForTextInRanges ranges: [NSValue], suggestedActions: [UIMenuElement]) -> UIMenu? {
            selectionMenu(textView)
        }
        private func selectionMenu(_ view: UITextView) -> UIMenu {
            let copy = UIAction(title: "复制", image: AgentCopyStyle.menuImage) { [weak view] _ in view?.copy(nil) }
            let all = UIAction(title: "全选", attributes: [.keepsMenuPresented]) { [weak view] _ in
                view?.selectAll(nil)
            }
            return UIMenu(children: [copy, all])
        }
    }
}
