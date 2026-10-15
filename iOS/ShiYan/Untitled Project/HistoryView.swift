import SwiftUI
import UIKit

struct HistoryView: View {
    @ObservedObject var history: HistoryManager
    let topInset: CGFloat
    let bottomInset: CGFloat
    let hasUnread: Bool
    let onSidebar: () -> Void
    @State private var previewEntry: HistoryEntry?
    @State private var editing = false
    @State private var selected = Set<UUID>()
    @State private var confirmDelete = false

    var body: some View {
        GeometryReader { geometry in
            navigationContent(safeAreaInsets: geometry.safeAreaInsets)
        }
    }

    private func navigationContent(safeAreaInsets: EdgeInsets) -> some View {
        Group {
            if viewMode == "grid" { gridView } else { listView }
        }
            .safeAreaBar(edge: .bottom, spacing: 0) {
                if editing { editBar(safeAreaInsets: safeAreaInsets) }
                else {
                    Color.clear.frame(height: 20)
                        .padding(.bottom, bottomInset)
                        .allowsHitTesting(false)
                }
            }
            .animation(.easeInOut(duration: 0.25), value: editing)
            .fullScreenCover(item: $previewEntry) { HistoryPreviewView(entry: $0, history: history) }
            .alert("删除所选 \(selected.count) 张记录？", isPresented: $confirmDelete) {
                Button("删除", role: .destructive) { deleteSelected() }
                Button("取消", role: .cancel) {}
            }
    }

    private var pageHeader: some View {
        ShiyanFeatureHeader(page: .space, topInset: topInset, hasUnread: hasUnread,
                            onSidebar: onSidebar) {
             
             
             
            Group {
                if editing {
                    ShiyanCloseButton(action: { exitEdit() }, diameter: ShiyanPreviewLayout.controlDiameter)
                        .accessibilityLabel("取消")
                        .accessibilityIdentifier("history-cancel-selection")
                } else {
                    moreMenu
                }
            }
            .transaction { transaction in
                transaction.animation = nil
                transaction.disablesAnimations = true
            }
        }
    }

     
    @State private var viewMode = UserDefaults.standard.string(forKey: "histViewMode") ?? "list"
    private func setViewMode(_ m: String) {
        viewMode = m
        UserDefaults.standard.set(m, forKey: "histViewMode")
    }

     
    private var moreMenu: some View {
        ShiyanMoreMenu {
            Button { enterEdit() } label: {
                HStack(spacing: 8) {
                    modeMenuIcon("checkmark.circle", selected: false)
                    Text("选择")
                }
            }
            Divider()
            Button { setViewMode("grid") } label: {
                HStack(spacing: 8) {
                    modeMenuIcon("square.grid.2x2", selected: viewMode == "grid")
                    Text("网格")
                }
            }
            Button { setViewMode("list") } label: {
                HStack(spacing: 8) {
                    modeMenuIcon("list.bullet", selected: viewMode == "list")
                    Text("列表")
                }
            }
        }
        .accessibilityIdentifier("history-more-menu")
    }

     
    private var listView: some View {
        List {
            if history.entries.isEmpty {
                VStack(spacing: 12) {
                    Image(systemName: "clock.badge.questionmark").font(.system(size: 40)).foregroundColor(.secondary)
                    Text("暂无历史记录").foregroundColor(.secondary)
                }
                .frame(maxWidth: .infinity, minHeight: 200)
                .listRowBackground(Color.clear)
            } else {
                ForEach(history.entries) { entry in
                    entryRow(entry)
                }
            }
        }
        .listStyle(.plain)
        .contentMargins(.top, topInset + 64, for: .scrollContent)
        .contentMargins(.bottom, 32, for: .scrollContent)
        .scrollBounceBehavior(.always)
        .scrollEdgeEffectStyle(.soft, for: .top)
        .scrollEdgeEffectStyle(.soft, for: .bottom)
        .safeAreaBar(edge: .top, spacing: -(topInset + 69)) { pageHeader }
    }

     
    private var gridView: some View {
        GeometryReader { geometry in
            let usableWidth = max(1, geometry.size.width - 32)
            let count = max(2, min(4, Int(usableWidth / 180)))
            let columnWidth = (usableWidth - CGFloat(count - 1) * 12) / CGFloat(count)
            let columns = HistoryMasonryLayout.columns(items: history.entries, columnCount: count,
                                                       columnWidth: Double(columnWidth), spacing: 12) {
                Double(max(1, $0.imageWidth)) / Double(max(1, $0.imageHeight))
            }
            ScrollView {
                if history.entries.isEmpty {
                    VStack(spacing: 12) {
                        ShiyanFeaturePage.space.icon.frame(width: 40, height: 40).foregroundStyle(.secondary)
                        Text("暂无历史记录").foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity, minHeight: geometry.size.height + 80, alignment: .top)
                    .padding(.top, topInset + 120)
                } else {
                    HStack(alignment: .top, spacing: 12) {
                        ForEach(columns.indices, id: \.self) { index in
                            LazyVStack(spacing: 12) {
                                ForEach(columns[index]) { entry in gridCard(entry) }
                            }.frame(width: columnWidth)
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.top, topInset + 64)
                    .padding(.bottom, 32)
                }
            }
            .scrollBounceBehavior(.always)
            .scrollEdgeEffectStyle(.soft, for: .top)
            .scrollEdgeEffectStyle(.soft, for: .bottom)
            .safeAreaBar(edge: .top, spacing: -(topInset + 69)) { pageHeader }
        }
    }

    private func gridCard(_ entry: HistoryEntry) -> some View {
        Button {
            if editing {
                toggleSelect(entry)
            } else {
                previewEntry = entry
            }
        } label: {
            Color.clear
                .aspectRatio(CGFloat(max(1, entry.imageWidth)) / CGFloat(max(1, entry.imageHeight)), contentMode: .fit)
                .overlay {
                    HistoryThumbnailView(entry: entry, history: history, contentMode: .fit)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
                .overlay(alignment: .topTrailing) {
                    if editing {
                        selectionIndicator(selected.contains(entry.id), style: .grid)
                            .padding(12)
                    }
                }
                .clipShape(RoundedRectangle(cornerRadius: ShiyanTheme.panelRadius, style: .continuous))
                .contentShape(RoundedRectangle(cornerRadius: ShiyanTheme.panelRadius, style: .continuous))
            }
        .buttonStyle(.plain)
        .accessibilityIdentifier("history-entry-\(entry.id.uuidString)")
        .accessibilityLabel("\(entry.filename), \(entry.modelName), \(entry.imageWidth)×\(entry.imageHeight)")
    }

     
    @ViewBuilder
    private func entryRow(_ entry: HistoryEntry) -> some View {
        row(entry)
    }

    private func row(_ entry: HistoryEntry) -> some View {
        Button {
            if editing {
                toggleSelect(entry)
            } else {
                previewEntry = entry
            }
        } label: {
            HStack(spacing: 12) {
                if editing {
                    selectionIndicator(selected.contains(entry.id), style: .list)
                }
                HistoryThumbnailView(entry: entry, history: history)
                    .frame(width: 60, height: 60)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                VStack(alignment: .leading, spacing: 4) {
                    Text(entry.filename).font(.subheadline).fontWeight(.medium)
                        .lineLimit(1).truncationMode(.middle)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Text("\(entry.modelName) · \(entry.imageWidth)×\(entry.imageHeight)")
                        .font(.caption).foregroundColor(.secondary).lineLimit(1)
                    Text(entry.createdAt, style: .date).font(.caption2).foregroundColor(.secondary).lineLimit(1)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .layoutPriority(1)
            }
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("history-entry-\(entry.id.uuidString)")
        .accessibilityLabel("\(entry.filename), \(entry.modelName), \(entry.imageWidth)×\(entry.imageHeight)")
        .listRowSeparator(.hidden)
    }

     
    private func editBar(safeAreaInsets: EdgeInsets) -> some View {
        let hasSelection = !selected.isEmpty
        let edgeDistance = max(
            CGFloat(32),
            max(safeAreaInsets.leading, max(safeAreaInsets.trailing, safeAreaInsets.bottom))
        )
        let actionInsets = EdgeInsets(
             
            top: 16,
            leading: max(0, edgeDistance - safeAreaInsets.leading),
            bottom: max(0, edgeDistance - safeAreaInsets.bottom),
            trailing: max(0, edgeDistance - safeAreaInsets.trailing)
        )
        let selectedURLs = history.entries
            .filter { selected.contains($0.id) }
            .map(\.fileURL)
        return HStack {
            ShareLink(
                items: selectedURLs,
                subject: Text("分享图片")
            ) {
                Image(systemName: "square.and.arrow.up")
                    .font(.system(size: 18, weight: .medium))
                    .frame(width: 48, height: 48)
                    .contentShape(Circle())
                    .foregroundStyle(hasSelection ? Color.primary : Color.secondary.opacity(0.45))
                    .glassEffect(
                        .regular
                            .tint(Color.white.opacity(0.05))
                            .interactive(),
                        in: Circle()
                    )
            }
            .buttonStyle(.plain)
            .contentShape(Circle())
            .allowsHitTesting(hasSelection)
            .accessibilityLabel("分享所选图片")

            Spacer(minLength: 0)

            Button(role: .destructive) {
                guard hasSelection else { return }
                confirmDelete = true
            } label: {
                Image(systemName: "trash")
                    .font(.system(size: 18, weight: .medium))
                    .frame(width: 48, height: 48)
                    .contentShape(Circle())
                    .foregroundStyle(hasSelection ? Color.primary : Color.secondary.opacity(0.45))
                    .glassEffect(
                        .regular
                            .tint(Color.white.opacity(0.05))
                            .interactive(),
                        in: Circle()
                    )
            }
            .buttonStyle(.plain)
            .contentShape(Circle())
            .allowsHitTesting(hasSelection)
            .accessibilityLabel("删除所选图片")
        }
        .frame(maxWidth: .infinity)
         
        .padding(actionInsets)
    }

     
    private func toggleSelect(_ entry: HistoryEntry) {
        if selected.contains(entry.id) {
            selected.remove(entry.id)
        } else {
            selected.insert(entry.id)
        }
    }

    private enum SelectionStyle: Equatable {
        case grid
        case list
    }

    private func selectionIndicator(_ isSelected: Bool, style: SelectionStyle) -> some View {
        let isGrid = style == .grid
        let selectedFill = isGrid ? ShiyanTheme.animeAccent : ShiyanTheme.accent
        let checkmarkColor = Color.white
        let unselectedFill = isGrid ? Color.black.opacity(0.12) : Color.clear
        let unselectedStroke = isGrid ? Color.white.opacity(0.96) : Color.secondary.opacity(0.38)

        return ZStack {
            Circle()
                .fill(isSelected ? selectedFill : unselectedFill)
            if isSelected {
                Image(systemName: "checkmark")
                    .font(.system(size: isGrid ? 12 : 10, weight: .bold))
                    .foregroundStyle(checkmarkColor)
            } else {
                Circle()
                    .stroke(unselectedStroke, lineWidth: isGrid ? 1.1 : 2)
            }
        }
        .frame(width: isGrid ? 24 : 20, height: isGrid ? 24 : 20)
        .shadow(color: isGrid ? .black.opacity(0.14) : .clear, radius: 1.5, y: 1)
        .accessibilityLabel(isSelected ? "已选中" : "未选中")
        .accessibilityValue(isGrid ? "网格" : "列表")
    }

    private func modeMenuIcon(_ icon: String, selected: Bool) -> some View {
        Image(uiImage: makeModeMenuIcon(icon: icon, selected: selected))
            .frame(width: 34, height: 20)
    }

    private func makeModeMenuIcon(icon: String, selected: Bool) -> UIImage {
        let originalConfig = UIImage.SymbolConfiguration(pointSize: 16, weight: .regular)
        let original = UIImage(systemName: icon, withConfiguration: originalConfig)?
            .withTintColor(.label, renderingMode: .alwaysOriginal)
        let checkmark = UIImage(systemName: "checkmark",
                                withConfiguration: UIImage.SymbolConfiguration(pointSize: 12, weight: .semibold))?
            .withTintColor(.label, renderingMode: .alwaysOriginal)

        let renderer = UIGraphicsImageRenderer(size: CGSize(width: 34, height: 20))
        return renderer.image { _ in
            if selected, let checkmark {
                checkmark.draw(in: CGRect(x: 0, y: 4, width: 12, height: 12))
            }
            if let original {
                 
                original.draw(in: CGRect(x: 17, y: 2, width: 16, height: 16))
            }
        }
    }

    private func enterEdit() {
        var transaction = Transaction(animation: nil)
        transaction.disablesAnimations = true
        withTransaction(transaction) { editing = true }
    }

    private func exitEdit() {
        var transaction = Transaction(animation: nil)
        transaction.disablesAnimations = true
        withTransaction(transaction) {
            editing = false
            selected.removeAll()
        }
    }

    private func deleteSelected() {
        let ids = selected
        history.remove(ids)
        selected.removeAll()
        if history.entries.isEmpty { editing = false }
    }
}

 
private struct HistoryThumbnailView: View {
    let entry: HistoryEntry
    let history: HistoryManager
    var contentMode: ContentMode = .fill
    @State private var image: CGImage?

    var body: some View {
        Group {
            if let image {
                Image(decorative: image, scale: 1.0)
                    .resizable()
                    .aspectRatio(contentMode: contentMode)
            } else {
                Rectangle().fill(Color(.secondarySystemGroupedBackground))
            }
        }
        .task(id: entry.id) {
            image = await history.thumbnail(for: entry)
        }
    }
}

struct HistoryPreviewView: View {
    let entry: HistoryEntry
    let history: HistoryManager
    @Environment(\.dismiss) var dismiss
    private let backgroundColor: Color = .black
    @State private var showControls = true
    @State private var previewImage: CGImage?
    @State private var downloading = false
    @State private var showToast = false
    @State private var toastMsg = ""

    var body: some View {
        ZStack {
            backgroundColor.ignoresSafeArea()
            if let img = previewImage {
                ZoomableImageView(image: img, showControls: $showControls, bg: backgroundColor)
                    .ignoresSafeArea()
            }
        }
        .overlay(alignment: .top) {
            if showControls {
                previewControls
                    .transition(.opacity)
            }
        }
        .overlay(alignment: .top) {
            if showToast {
                Text(toastMsg)
                    .font(.subheadline)
                    .foregroundStyle(.white)
                    .padding(.horizontal, 18)
                    .padding(.vertical, 10)
                    .background(.black.opacity(0.72), in: Capsule())
                    .padding(.top, ShiyanPreviewLayout.toastTopPadding)
                    .transition(.move(edge: .top).combined(with: .opacity))
            }
        }
        .animation(.easeInOut(duration: 0.25), value: showControls)
        .animation(.easeInOut(duration: 0.25), value: showToast)
        .ignoresSafeArea(.container)
        .task(id: entry.id) {
             
            previewImage = await Task.detached(priority: .userInitiated) {
                entry.image
            }.value
        }
    }

    private var previewControls: some View {
        HStack {
            ShiyanCloseButton(
                action: { dismiss() },
                foreground: .white,
                tint: .black.opacity(0.28),
                diameter: ShiyanPreviewLayout.controlDiameter
            )
            Spacer()
            if previewImage != nil {
                ShiyanPreviewSaveButton(
                    isSaving: downloading,
                    action: downloadImage,
                    accessibilityText: "下载图片"
                )
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, ShiyanPreviewLayout.topPadding)
    }

    private func downloadImage() {
        guard !downloading else { return }
        downloading = true
        Task { @MainActor in
            let success = await history.saveEntry(entry)
            downloading = false
            toastMsg = success ? "已下载到相册" : "下载失败，请检查相册权限"
            showToast = true
            try? await Task.sleep(for: .seconds(1.8))
            showToast = false
        }
    }
}

class CenteredScrollView: UIScrollView {
    weak var zoomCoordinator: ZoomableImageView.Coordinator?
    private var didInitCenter = false

    override func layoutSubviews() {
        super.layoutSubviews()
        guard let c = zoomCoordinator, !didInitCenter, bounds.height > 0 else { return }
        didInitCenter = true
        c.centerContent(self)
    }
}

struct ZoomableImageView: UIViewRepresentable {
    let image: CGImage
    @Binding var showControls: Bool
    var bg: Color = .clear

    func makeUIView(context: Context) -> CenteredScrollView {
        let sv = CenteredScrollView()
        sv.zoomCoordinator = context.coordinator
        sv.delegate = context.coordinator
        sv.showsHorizontalScrollIndicator = false
        sv.showsVerticalScrollIndicator = false

        let iv = UIImageView(image: UIImage(cgImage: image))
        iv.contentMode = .scaleAspectFit
        let screen = UIScreen.main.bounds.size
        let imgW = CGFloat(image.width), imgH = CGFloat(image.height)
        let fit = min(screen.width / imgW, screen.height / imgH)
        let fw = imgW * fit, fh = imgH * fit
        iv.frame = CGRect(origin: .zero, size: CGSize(width: fw, height: fh))
        iv.isUserInteractionEnabled = true
        sv.addSubview(iv)
        sv.contentSize = iv.frame.size
        sv.minimumZoomScale = 1
        sv.maximumZoomScale = 5
        sv.zoomScale = 1

        context.coordinator.fitH = fh
        context.coordinator.imageView = iv

        let singleTap = UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.toggleControls))
        iv.addGestureRecognizer(singleTap)

        let doubleTap = UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.handleDoubleTap(_:)))
        doubleTap.numberOfTapsRequired = 2
        iv.addGestureRecognizer(doubleTap)
        singleTap.require(toFail: doubleTap)

        context.coordinator.scrollView = sv
        context.coordinator.showControls = _showControls

        return sv
    }

    func updateUIView(_ sv: CenteredScrollView, context: Context) {
        context.coordinator.showControls = _showControls
        sv.backgroundColor = UIColor(bg)
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    class Coordinator: NSObject, UIScrollViewDelegate {
        weak var imageView: UIImageView?
        weak var scrollView: UIScrollView?
        var showControls: Binding<Bool>?
        var fitH: CGFloat = 0

        func viewForZooming(in scrollView: UIScrollView) -> UIView? { imageView }
        func scrollViewDidZoom(_ scrollView: UIScrollView) { centerContent(scrollView) }

        func centerContent(_ sv: UIScrollView) {
            let x = max((sv.bounds.width - sv.contentSize.width) / 2, 0)
            let y = max((sv.bounds.height - sv.contentSize.height) / 2, 0)
            sv.contentInset = UIEdgeInsets(top: y, left: x, bottom: y, right: x)
            if fitH > sv.bounds.height {
                sv.contentOffset = CGPoint(x: 0, y: (fitH - sv.bounds.height) / 2)
            }
        }

        @objc func toggleControls() { showControls?.wrappedValue.toggle() }

        @objc func handleDoubleTap(_ gesture: UITapGestureRecognizer) {
            guard let sv = scrollView else { return }
            if sv.zoomScale > sv.minimumZoomScale {
                sv.setZoomScale(sv.minimumZoomScale, animated: true)
            } else {
                let point = gesture.location(in: imageView)
                let zoomRect = CGRect(x: point.x - 50, y: point.y - 50, width: 100, height: 100)
                sv.zoom(to: zoomRect, animated: true)
            }
        }
    }
}
