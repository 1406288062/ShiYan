import Combine
import SwiftUI
import PhotosUI
import UniformTypeIdentifiers
import AVFoundation
import UIKit

 
 
 
 
private struct AgentMultilineContextPreviewLayout: Layout {
    let maxBubbleWidth: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        guard let bubble = subviews.first else { return .zero }
        // UIKit probes a context preview with compressed proposals. Reflowing
        // long text at those widths produces a tall, narrow preview snapshot.
        let size = bubble.sizeThatFits(ProposedViewSize(width: maxBubbleWidth, height: nil))
        return CGSize(width: maxBubbleWidth, height: size.height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        guard let bubble = subviews.first else { return }
        bubble.place(at: bounds.origin, anchor: .topLeading, proposal: ProposedViewSize(width: maxBubbleWidth, height: nil))
    }
}

 
 
private final class AgentAttachmentAnchorCache {
    var frame: CGRect = .zero
}


 
 
@MainActor
private final class AgentReasoningPresentation: ObservableObject {
    let backdropSource = AgentReasoningBackdropSource()
    @Published private(set) var isOpen = false

    func open() {
        guard !isOpen else { return }
        backdropSource.activate()
        isOpen = true
    }

    func close() {
        guard isOpen else { return }
        // Stop readback before restoring the composer and its glass effects.
        backdropSource.deactivate()
        isOpen = false
    }
}

private struct AgentReasoningVisibility: ViewModifier {
    @ObservedObject var presentation: AgentReasoningPresentation

    func body(content: Content) -> some View {
         
         
        content
            .mask { Rectangle().fill(presentation.isOpen ? Color.clear : Color.white) }
            .accessibilityHidden(presentation.isOpen)
    }
}

 
 
private struct AgentReasoningScrollEdge: ViewModifier {
    @ObservedObject var presentation: AgentReasoningPresentation

    func body(content: Content) -> some View {
        // The slider already has a local defocus. Do not add the composer's
        // full-width scroll-edge veil while its visible content is masked.
        content.scrollEdgeEffectHidden(presentation.isOpen, for: .bottom)
    }
}

private struct AgentReasoningMessageField: View {
    @ObservedObject var presentation: AgentReasoningPresentation
    @Binding var text: String
    let focused: FocusState<Bool>.Binding

    var body: some View {
        // Keep the native editor and its focus alive; hide only its ink.
        TextField("发送消息", text: $text,
            prompt: Text("发送消息").foregroundColor(presentation.isOpen
                ? .clear : Color(uiColor: .placeholderText)), axis: .vertical)
            .foregroundStyle(presentation.isOpen ? Color.clear : Color.primary)
            .tint(presentation.isOpen ? Color.clear : Color.accentColor)
            .focused(focused)
    }
}

private struct AgentReasoningComposerSurface: ViewModifier {
    @ObservedObject var presentation: AgentReasoningPresentation
    let cornerRadius: CGFloat

    func body(content: Content) -> some View {
        content.agentComposerSurface(cornerRadius: cornerRadius,
                                     glassVisible: !presentation.isOpen)
    }
}

private struct AgentReasoningDrawerGesture: ViewModifier {
    @ObservedObject var presentation: AgentReasoningPresentation
    let progress: CGFloat
    let excludedFrame: CGRect
    let changed: (CGFloat) -> Void
    let ended: (CGFloat, CGFloat, Bool) -> Void

    func body(content: Content) -> some View {
        content.gesture(AgentDrawerPanGesture(
            progress: progress,
            excludedFrame: presentation.isOpen ? .infinite : excludedFrame,
            changed: changed, ended: ended))
    }
}

private struct AgentReasoningPullObserver: View {
    @ObservedObject var presentation: AgentReasoningPresentation
    let enabled: Bool
    let topExclusion: CGFloat
    let conversationID: UUID?
    let began: () -> Void
    let changed: (CGFloat) -> Void
    let ended: (Bool) -> Void

    var body: some View {
        AgentNewChatPullObserver(enabled: enabled && !presentation.isOpen,
                                 topExclusion: topExclusion, conversationID: conversationID,
                                 began: began, changed: changed, ended: ended)
    }
}

private struct AgentReasoningPresentationLayer: View {
    @ObservedObject var presentation: AgentReasoningPresentation
    let backdropSource: AgentReasoningBackdropSource
    let models: [AgentModelOption]
    @Binding var model: String
    @Binding var effort: String
    let bottomGap: CGFloat
    let composerHeight: CGFloat
    let keyboardVisible: Bool
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ZStack(alignment: .bottom) {
            if presentation.isOpen {
                AgentReasoningDefocus(source: backdropSource,
                    composerBottomGap: bottomGap,
                    composerHeight: composerHeight,
                    horizontalInset: AgentReasoningControl.glassHorizontalInset,
                    backgroundColor: colorScheme == .dark ? UIColor(white: 0.065, alpha: 1) : .white)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
                    .transition(.identity)
                    .transaction { transaction in
                        transaction.animation = nil
                        transaction.disablesAnimations = true
                    }
                Color.clear.contentShape(Rectangle())
                    .onTapGesture { presentation.close() }
                 
                 
                AgentReasoningControl(models: models, model: $model,
                                      selected: $effort, dismiss: presentation.close)
                     
                     
                    .padding(.bottom, keyboardVisible ? 0 : max(0, bottomGap - AgentComposerLayout.gutter))
                    .offset(y: keyboardVisible ? AgentReasoningControl.lowerGlassReserve - 16 : 0)
                    .transition(.opacity)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .allowsHitTesting(presentation.isOpen)
        .accessibilityHidden(!presentation.isOpen)
        .animation(reduceMotion ? nil : .easeOut(duration: 0.12), value: presentation.isOpen)
    }
}

struct AIAgentView: View {
    @ObservedObject var history: HistoryManager
    @StateObject private var store: AgentStore
    @Environment(\.dismiss) private var dismiss
    @State private var temporaryStore: AgentStore?
    @State private var showingTemporaryChat = false
    @State private var showingExecutionHistory = false
    @State private var showingScanner = false

    init(history: HistoryManager, store: AgentStore? = nil) {
        self.history = history
        _store = StateObject(wrappedValue: store ?? AgentStore.shared)
    }
    @StateObject private var speech = AgentSpeechInput()
    @ObservedObject private var dotsVoice = DotsVoiceSession.shared
    @State private var dotsTaskSheetPresented = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.scenePhase) private var scenePhase
    @State private var featurePage: ShiyanFeaturePage?
    @State private var settingsReturnPage: ShiyanFeaturePage?
    @State private var liveInputScope: AgentLiveInputScope?
    @State private var liveInputRequests: [AgentLiveInputRequest] = []
    @State private var submittingLiveInputs = Set<String>()
    @State private var answeredLiveInputs = Set<String>()
    @State private var structuredInputJobs = Set<String>()
    @State private var inputText = ""
    @State private var drawer: CGFloat = 0
    @State private var dragOrigin: CGFloat?
    @State private var reasoningPresentation = AgentReasoningPresentation()
    private var reasoningBackdropSource: AgentReasoningBackdropSource {
        reasoningPresentation.backdropSource
    }
    @State private var attachmentOpen = false
    @State private var attachmentAnchor = AgentAttachmentAnchorCache()
    @State private var attachmentButtonFrame: CGRect = .zero
    @State private var attachmentCardFrame: CGRect = .zero
    @State private var showPhotos = false
    @State private var showCamera = false
    @State private var showFiles = false
    @State private var attachmentConversationID: UUID?
    @State private var photos: [PhotosPickerItem] = []
    @State private var loadingPhotos = false
    @State private var imageLoadErrors: [UUID: String] = [:]
    @State private var imageLoadRequest = 0
    @State private var preview: AgentAsset?
    @State private var editedMessageID: UUID?
    @State private var editInFlight = false
    @State private var previousDraftBeforeEdit: String?
    @State private var previousAssetsBeforeEdit: [AgentAsset]?
    @State private var speechBase = ""
    @State private var speechConversationID: UUID?
    @State private var atLatest = true
    @State private var followLatest = true
    @State private var chatScrollPosition = ScrollPosition(edge: .bottom)
    @State private var scrollIsUserDriven = false
    @State private var bottomScrollRequest = 0
    @State private var pagingHistory = false
    @State private var inlineSelectionMessageID: UUID?
    @State private var inlineSelectionRequestID = 0
    @State private var inlineSelectionActive = false
    @State private var copiedMessageID: UUID?
    @State private var copyFeedbackTask: Task<Void, Never>?
    @State private var keyboardVisible = false
    @State private var keyboardTransitionInFlight = false
    @State private var deferredMessageScroll = false
    @State private var keyboardTargetFrame: CGRect = .null
    @State private var composerHeight: CGFloat = 64
    @State private var newChatPull = AgentNewChatPullState()
    @State private var newChatReadyVisual = false
    @State private var pullConversationID: UUID?
    @State private var newChatSwitchInFlight = false
    @State private var newChatSwitchTask: Task<Void, Never>?
    @State private var pullReadyFeedback = UIImpactFeedbackGenerator(style: .medium)
    @State private var pullCommitFeedback = UIImpactFeedbackGenerator(style: .soft)
    @State private var resolvedScreenCorners: RectangleCornerRadii?
    @FocusState private var inputFocused: Bool

    private var current: AgentConversation? { store.current }
    private var currentLiveInputScope: AgentLiveInputScope? {
        guard !store.historyLoading, let conversation = current,
              let message = conversation.messages.last, message.role == .assistant,
              let jobID = message.remoteJobID ?? conversation.pendingJobID else { return nil }
        return AgentLiveInputScope(conversationID: conversation.id, messageID: message.id,
            jobID: jobID, accountGeneration: ShiyanAccountStorage.generation,
            isWorking: message.isWorking || conversation.isBusy)
    }
    private var pollingLiveInputScope: AgentLiveInputScope? {
        scenePhase == .active && featurePage == nil ? currentLiveInputScope : nil
    }

    private func pollLiveInputs(_ scope: AgentLiveInputScope) async {
        if liveInputScope != scope {
            if liveInputScope?.jobID != scope.jobID || liveInputScope?.accountGeneration != scope.accountGeneration {
                answeredLiveInputs.removeAll(); submittingLiveInputs.removeAll()
            }
            liveInputScope = scope; liveInputRequests = []
        }
        let client = CodexClient.shared
        while !Task.isCancelled && currentLiveInputScope == scope {
            do {
                let requests = try await client.liveInputRequests(jobID: scope.jobID)
                guard !Task.isCancelled, currentLiveInputScope == scope,
                      ShiyanAccountStorage.generation == scope.accountGeneration else { return }
                if requests.contains(where: { $0.jobId == scope.jobID }) {
                    if structuredInputJobs.count > 80 { structuredInputJobs.removeAll() }
                    structuredInputJobs.insert(scope.jobID)
                }
                let visible = requests.filter {
                    $0.jobId == scope.jobID && ["pending", "cancelled", "expired"].contains($0.status) &&
                    !$0.questions.isEmpty && !answeredLiveInputs.contains($0.id)
                }
                if liveInputRequests != visible { liveInputRequests = visible }
            } catch {
                if Task.isCancelled || ShiyanAccountStorage.generation != scope.accountGeneration { return }
                // Keep existing selections on a transient failure and retry while visible.
            }
            if !scope.isWorking { return }
            do { try await Task.sleep(for: .milliseconds(1500)) } catch { return }
        }
    }
    private func submitLiveInput(_ request: AgentLiveInputRequest, answers: [String: String], scope: AgentLiveInputScope) async -> String? {
        guard currentLiveInputScope == scope, liveInputScope == scope,
              ShiyanAccountStorage.generation == scope.accountGeneration,
              request.jobId == scope.jobID, request.status == "pending",
              liveInputRequests.contains(request), !submittingLiveInputs.contains(request.id),
              let payload = request.answerPayload(answers) else { return "问题已变化，请查看当前问题后重试" }
        submittingLiveInputs.insert(request.id)
        defer { submittingLiveInputs.remove(request.id) }
        do {
            let result = try await CodexClient.shared.answerLiveInput(jobID: scope.jobID, requestID: request.id, answers: payload)
            guard ShiyanAccountStorage.generation == scope.accountGeneration,
                  store.selectedID == scope.conversationID,
                  current?.messages.last?.id == scope.messageID else { return nil }
            guard result.id == request.id, result.jobId == scope.jobID, result.status == "answered" else {
                return "问题已失效，请查看当前问题后重试"
            }
            answeredLiveInputs.insert(request.id)
            liveInputRequests.removeAll { $0.id == request.id }
            return nil
        } catch {
            guard ShiyanAccountStorage.generation == scope.accountGeneration,
                  store.selectedID == scope.conversationID else { return nil }
            return error.localizedDescription
        }
    }
    @ViewBuilder
    private func liveQuestionForms(message: AgentMessage, conversationID: UUID) -> some View {
        if let scope = currentLiveInputScope, scope == liveInputScope,
           scope.conversationID == conversationID, scope.messageID == message.id {
            ForEach(liveInputRequests) { request in
                if request.status == "pending" {
                    AgentQuestionForm(questions: request.choices, isBusy: submittingLiveInputs.contains(request.id)) { answers in
                        await submitLiveInput(request, answers: answers, scope: scope)
                    }
                    .id(scope.jobID + ":" + request.id)
                } else {
                    Text(request.status == "expired" ? "问题已过期" : "问题已取消")
                        .font(.footnote).foregroundStyle(.secondary)
                }
            }
        }
        // Old replies can still contain ordinary Markdown choices. Never stop an
        // active server job merely to turn those words into a new user message.
        if !message.isWorking, store.conversation(conversationID)?.isBusy != true, !structuredInputJobs.contains(message.remoteJobID ?? "") {
            let questions = AgentChoiceQuestion.parse(message.text)
            if !questions.isEmpty {
                AgentQuestionForm(questions: questions, isBusy: store.answeringQuestions.contains(conversationID)) { answers in
                    let sent = await store.answerQuestions(questions, answers: answers,
                        conversationID: conversationID, messageID: message.id)
                    return sent ? nil : (store.notice ?? "选择尚未提交，请重试")
                }
                .id(message.id)
            }
        }
    }
    private var canPullNewChat: Bool {
        !store.isTemporarySession && featurePage == nil && !store.hasEarlierMessages && !store.historyLoading && !store.loadingEarlier && !(current?.messages.isEmpty ?? true) && drawer == 0 && dragOrigin == nil &&
        !attachmentOpen && !keyboardVisible && !inputFocused &&
        !speech.isRecording && !speech.isStarting && !showPhotos && !showCamera &&
        !showFiles && preview == nil && !inlineSelectionActive && !editInFlight &&
        !newChatSwitchInFlight && scenePhase == .active
    }
    private var messagePreviewWidth: CGFloat {
        let windows = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows)
        let width = windows.first(where: \.isKeyWindow)?.bounds.width ?? 390
        return min(360, max(160, width * 0.78))
    }
    private var messagePreviewLineLimit: Int {
        let height = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows).first(where: \.isKeyWindow)?.bounds.height ?? 844
        let availableHeight = min(360, height * 0.45) - 26
        let lineHeight = UIFont.preferredFont(forTextStyle: .body).lineHeight + 5
        return max(1, Int(availableHeight / lineHeight))
    }
    private func bubblePreviewWidth(for text: String) -> CGFloat {
         
         
        let font = UIFont.preferredFont(forTextStyle: .body)
        let intrinsic = ceil((text as NSString).size(withAttributes: [.font: font]).width + 26)
        let screen = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows).first(where: \.isKeyWindow)?.bounds.width ?? 390
        return min(max(80, screen - 72), max(80, intrinsic))
    }
    private var reasoning: Binding<String> { Binding(get: { store.current?.reasoning ?? "low" }, set: { store.setReasoning($0) }) }
    private var insets: UIEdgeInsets {
        UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows).first(where: \.isKeyWindow)?.safeAreaInsets ?? UIEdgeInsets(top: 59, left: 0, bottom: 34, right: 0)
    }

    var body: some View {
        GeometryReader { geometry in
            let width = geometry.size.width
            let top = insets.top
            let bottom = max(insets.bottom, 12)
             
            let window = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
                .flatMap(\.windows).first(where: \.isKeyWindow)
            let screenSize = window?.bounds.size ?? geometry.size
            let composerBottom = AgentComposerLayout.bottomGap(
                windowBottom: window?.bounds.maxY ?? geometry.frame(in: .global).maxY,
                windowSafeBottom: insets.bottom, viewportBottom: geometry.frame(in: .global).maxY)
            let measuredCorners = geometry.concentricCornerRadii(in: CGRect(origin: .zero, size: screenSize))
            let corners = resolvedScreenCorners ?? measuredCorners ?? RectangleCornerRadii()
             
             
             
             
            let deviceCornerFallback: CGFloat = width < 600 ? 55 : 24
            let panelCornerRadius = min(max(deviceCornerFallback,
                                           corners.topLeading, corners.bottomLeading,
                                           corners.topTrailing, corners.bottomTrailing),
                                        width * 0.19)
             
             
            let viewportBottom = geometry.frame(in: .global).maxY
            let physicalBottom = window?.bounds.maxY ?? viewportBottom
            let bottomCornerRadius = physicalBottom - viewportBottom > 1 ? 0 : panelCornerRadius
            let panelOutline = UnevenRoundedRectangle(
                topLeadingRadius: panelCornerRadius, bottomLeadingRadius: bottomCornerRadius,
                bottomTrailingRadius: bottomCornerRadius, topTrailingRadius: panelCornerRadius,
                style: .continuous)
            ZStack(alignment: .leading) {
                 
                 
                 
                 
                (colorScheme == .dark ? Color(white: 0.065)
                                      : Color(white: 1.0 - Double(drawer) * 0.015))
                AgentSidebar(store: store, topInset: top, bottomInset: bottom, isOpen: drawer > 0.98, revealProgress: drawer, onFeature: openFeaturePage) { id in
                    speech.cancel(); speechConversationID = nil
                    featurePage = nil
                    resetConversationPresentation()
                    store.select(id); editedMessageID = nil; atLatest = true
                    setDrawer(false)
                }
                .frame(width: width * 0.75)
                 
                 
                .opacity(drawer > 0 ? 1 : 0)
                .allowsHitTesting(drawer > 0.98)
                .accessibilityHidden(drawer < 0.98)

                mainPanel(top: top, bottom: bottom, composerBottom: composerBottom, height: geometry.size.height, width: width)
                     
                     
                    .allowsHitTesting(drawer == 0 && dragOrigin == nil)
                    .frame(width: width)
                     
                     
                    .background(colorScheme == .dark ? Color(white: 0.065) : Color.white)
                    .compositingGroup()
                    .overlay {
                        if colorScheme == .dark {
                            Color.white.opacity(0.045 * Double(drawer)).allowsHitTesting(false)
                        }
                    }
                     
                     
                    .clipShape(panelOutline)
                    .overlay {
                        if colorScheme == .dark {
                            panelOutline
                                .strokeBorder(Color.white.opacity(0.18 * Double(drawer)), lineWidth: 0.5)
                                .allowsHitTesting(false)
                        }
                    }
                     
                    .shadow(color: .black.opacity(colorScheme == .dark
                                                   ? 0.13 * drawer : 0.075 * drawer),
                            radius: 17, x: -5, y: 0)
                    .offset(x: width * 0.75 * drawer)
                    .accessibilityHidden(drawer > 0.5)

                if drawer > 0.98 && dragOrigin == nil {
                     
                    Button { setDrawer(false) } label: { Color.clear.contentShape(Rectangle()) }
                        .buttonStyle(.plain)
                        .frame(width: width * 0.25, height: geometry.size.height)
                        .offset(x: width * 0.75)
                        .accessibilityLabel("收起侧边栏")
                }

                AgentNewChatPullIndicator(progress: newChatPull.progress, reveal: newChatPull.reveal,
                                          ready: newChatReadyVisual, reduceMotion: reduceMotion)
                    .position(x: width / 2,
                              y: geometry.size.height - bottom - composerHeight - 50 -
                                 CGFloat(newChatPull.resistedDistance) * 0.46)
                    .offset(y: newChatSwitchInFlight && !reduceMotion ? -26 : 0)
                    .allowsHitTesting(false)
                    .accessibilityHidden(newChatPull.distance < 5)

                if attachmentOpen {
                    Color.clear.contentShape(Rectangle())
                        .onTapGesture { closeAttachments() }
                    attachmentCard
                        .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { attachmentCardFrame = $0 }
                        .position(x: min(width - 132, max(132, attachmentButtonFrame.minX - geometry.frame(in: .global).minX + 120)),
                                  y: max(top + 116, attachmentButtonFrame.minY - geometry.frame(in: .global).minY - 116))
                        .transition(.opacity.combined(with: .scale(scale: 0.96, anchor: .bottomLeading)))
                }

                AgentReasoningPresentationLayer(
                    presentation: reasoningPresentation, backdropSource: reasoningBackdropSource,
                    models: store.capabilities.availableModels,
                    model: Binding(get: { store.selectedModel.id }, set: { store.setModel($0) }),
                    effort: reasoning, bottomGap: composerBottom,
                    composerHeight: composerHeight, keyboardVisible: keyboardVisible)

                DotsVoiceCallOverlay(isDotsVisible: featurePage == .dots && drawer == 0,
                                     topInset: top, showsCallCard: !dotsTaskSheetPresented)
                    .zIndex(40)
            }
            .clipped()
            .onChange(of: measuredCorners, initial: true) { _, value in
                 
                guard let value, value.topLeading + value.bottomLeading + value.topTrailing + value.bottomTrailing > 0,
                      dragOrigin == nil, !keyboardVisible,
                      abs(geometry.frame(in: .global).minY) < 1 else { return }
                var transaction = Transaction(); transaction.animation = nil
                withTransaction(transaction) { resolvedScreenCorners = value }
            }
            .contentShape(Rectangle())
            .background {
                AgentDrawerGeometryProbe(progress: drawer, radii: corners)
            }
             
             
            .modifier(AgentReasoningDrawerGesture(
                presentation: reasoningPresentation, progress: drawer,
                excludedFrame: featurePage == .dots && drawer < 0.001 ? .infinite : (attachmentOpen ? attachmentCardFrame : .zero),
                changed: { updateDrawerDrag($0, width: width) },
                ended: { finishDrawerDrag(translation: $0, velocity: $1, cancelled: $2, width: width) }
            ))
        }
        .ignoresSafeArea(.container)
        .photosPicker(isPresented: $showPhotos, selection: $photos,
                      maxSelectionCount: max(1, store.capabilities.maxUploadImages - (current?.draftAssets.count ?? 0)), matching: .images)
        .fullScreenCover(isPresented: $showingTemporaryChat, onDismiss: {
            temporaryStore?.closeTemporarySession()
            temporaryStore = nil
        }) {
            if let temporaryStore { AIAgentView(history: history, store: temporaryStore) }
        }
        .fullScreenCover(isPresented: $showingScanner) { ShiyanQRScanner() }
        .sheet(isPresented: $showingExecutionHistory) {
            AgentExecutionHistoryView(messages: current?.messages ?? [])
        }
        .sheet(isPresented: $showCamera) {
            AgentCameraPicker { image in
                showCamera = false
                guard let image, let id = attachmentConversationID else { return }
                do { store.addDraftAssets([try AgentMedia.saveImage(image)], to: id) }
                catch { store.notice = error.localizedDescription }
            }.ignoresSafeArea()
        }
        .fileImporter(isPresented: $showFiles, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            importFiles(result)
        }
        .fullScreenCover(item: $preview) { asset in
            if asset.isImage, let image = UIImage(contentsOfFile: asset.url.path) {
                GeneratedImagePreview(image: image)
            } else {
                NavigationStack {
                    AgentDocumentPreview(asset: asset)
                        .navigationTitle(asset.filename)
                        .navigationBarTitleDisplayMode(.inline)
                        .toolbar { ToolbarItem(placement: .topBarLeading) { Button("关闭") { preview = nil } } }
                }
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .dotsVoiceWillStart)) { _ in
            speech.cancel(); speechConversationID = nil
        }
        .alert("提示", isPresented: Binding(get: { store.notice != nil || speech.errorMessage != nil || dotsVoice.errorMessage != nil }, set: { if !$0 { store.notice = nil; speech.errorMessage = nil; dotsVoice.dismissError() } })) {
            Button("好", role: .cancel) { store.notice = nil; speech.errorMessage = nil; dotsVoice.dismissError() }
        } message: { Text(store.notice ?? speech.errorMessage ?? dotsVoice.errorMessage ?? "") }
        .task {
            inputText = store.current?.draft ?? ""
            store.attach(history: history)
            store.visibleConversationID = drawer == 0 && featurePage == nil ? store.selectedID : nil
            store.viewingLatest = atLatest
            if let id = store.visibleConversationID { store.viewedLatest(id) }
            await store.prepare()
#if DEBUG
            await DotsSmoke.runIfRequested()
#endif
        }

        .task(id: pollingLiveInputScope) {
            guard let scope = pollingLiveInputScope else { return }
            await pollLiveInputs(scope)
        }

        .onChange(of: canPullNewChat) { _, enabled in
            if !enabled { cancelNewChatPull() }
        }
        .onChange(of: store.selectedID) { _, _ in
             
             
            resetConversationPresentation()
        }
        .onDisappear {
            resetConversationPresentation()
            keyboardTransitionInFlight = false
            deferredMessageScroll = false
            keyboardTargetFrame = .null
            cancelNewChatPull(animated: false)
            newChatSwitchTask?.cancel(); newChatSwitchTask = nil; newChatSwitchInFlight = false
            copyFeedbackTask?.cancel(); copyFeedbackTask = nil; copiedMessageID = nil
            if let id = store.visibleConversationID { store.viewedLatest(id) }
            store.visibleConversationID = nil; speech.cancel(); speechConversationID = nil; store.persist()
        }
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.didBecomeActiveNotification)) { _ in
            keyboardTransitionInFlight = false
            deferredMessageScroll = false
            keyboardTargetFrame = .null
            store.visibleConversationID = drawer == 0 && featurePage == nil ? store.selectedID : nil
            if let id = store.visibleConversationID { store.viewedLatest(id) }
            Task { await store.prepare() }
        }
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.didEnterBackgroundNotification)) { _ in
            resetConversationPresentation()
            keyboardTransitionInFlight = false
            deferredMessageScroll = false
            keyboardTargetFrame = .null
            if let id = store.visibleConversationID { store.viewedLatest(id) }
            store.visibleConversationID = nil; speech.cancel(); store.persist()
        }
        .onChange(of: photos) { _, items in
            guard !items.isEmpty, let id = attachmentConversationID else { return }
            loadingPhotos = true
            Task {
                defer { loadingPhotos = false; photos = [] }
                var assets: [AgentAsset] = []
                do {
                    for item in items {
                        guard let data = try await item.loadTransferable(type: Data.self), let image = UIImage(data: data) else { throw AgentClientError.message("无法读取选中的图片") }
                        assets.append(try AgentMedia.saveImage(image))
                    }
                    store.addDraftAssets(assets, to: id)
                } catch { store.notice = error.localizedDescription }
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillChangeFrameNotification)) { note in
            guard let frame = note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect,
                  let window = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).flatMap(\.windows).first(where: \.isKeyWindow) else { return }
            let keyboardFrame = window.convert(frame, from: window.screen.coordinateSpace)
            let visible = window.bounds.intersection(keyboardFrame).height > 30
            guard keyboardFrame != keyboardTargetFrame || keyboardVisible != visible else { return }
            keyboardTargetFrame = keyboardFrame
            keyboardTransitionInFlight = true
            if keyboardVisible != visible { keyboardVisible = visible }
        }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)) { _ in
            guard keyboardVisible || keyboardTransitionInFlight else { return }
            keyboardTransitionInFlight = true
            if keyboardVisible { keyboardVisible = false }
        }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardDidChangeFrameNotification)) { _ in
            finishKeyboardTransition()
        }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardDidShowNotification)) { _ in
            finishKeyboardTransition()
        }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardDidHideNotification)) { _ in
            finishKeyboardTransition()
        }
        .onChange(of: inputText) { _, value in
             
             
            closeReasoning()
            store.setDraft(value)
        }
        .onChange(of: speech.transcript) { _, text in
            guard let speechConversationID, speechConversationID == store.selectedID,
                  !text.isEmpty else { return }
            inputText = speechBase + text
        }
    }

    private func openFeaturePage(_ page: ShiyanFeaturePage) {
        speech.cancel(); speechConversationID = nil
        inputFocused = false
        closeAttachments(); closeReasoning()
        cancelNewChatPull(animated: false)
        store.persist()
        store.visibleConversationID = nil
        if page == .settings && featurePage != .settings { settingsReturnPage = featurePage }
        featurePage = page
        setDrawer(false)
    }

    @ViewBuilder
    private func mainPanel(top: CGFloat, bottom: CGFloat, composerBottom: CGFloat, height: CGFloat, width: CGFloat) -> some View {
        let hasUnread = store.conversations.contains { $0.hasUnread }
        switch featurePage {
        case .enhance:
            EnhanceView(history: history, topInset: top, hasUnread: hasUnread) { setDrawer(true) }
        case .space:
            HistoryView(history: history, topInset: top, bottomInset: bottom, hasUnread: hasUnread) { setDrawer(true) }
        case .knowledge:
            KnowledgeView(topInset: top, bottomInset: bottom, hasUnread: hasUnread) { setDrawer(true) }
        case .dots:
            DotsView(topInset: top, bottomInset: bottom, hasUnread: hasUnread,
                     isConversationVisible: drawer == 0 && dragOrigin == nil,
                     onSidebar: { setDrawer(true) },
                     onTaskSheetPresented: { dotsTaskSheetPresented = $0 })
        case .scheduled:
            ScheduledTasksView(topInset: top, bottomInset: bottom, hasUnread: hasUnread) { setDrawer(true) }
        case .settings:
            SettingsView(topInset: top, bottomInset: bottom, hasUnread: hasUnread,
                         onSidebar: { setDrawer(true) }) {
                featurePage = settingsReturnPage
                settingsReturnPage = nil
                store.visibleConversationID = drawer == 0 && featurePage == nil ? store.selectedID : nil
                if let id = store.visibleConversationID { store.viewedLatest(id) }
            }
        case nil:
            chatPanel(top: top, composerBottom: composerBottom, height: height, width: width)
        }
    }

    private func loadEarlierHistory() async {
        guard !pagingHistory, store.hasEarlierMessages else { return }
        pagingHistory = true; followLatest = false
        let id = store.selectedID
        let anchor = await store.loadEarlierMessages()
        await Task.yield()
        if store.selectedID == id, let anchor {
            var transaction = Transaction(); transaction.animation = nil
            withTransaction(transaction) { chatScrollPosition.scrollTo(id: anchor, anchor: .top) }
        }
        pagingHistory = false
    }

    private func chatPanel(top: CGFloat, composerBottom: CGFloat, height: CGFloat, width: CGFloat) -> some View {
         
        let topBlurEarlyLead: CGFloat = 20
        return ZStack(alignment: .top) {
            Group {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 24) {
                        if let conversation = current {
                            if store.historyLoading {
                                ProgressView().frame(maxWidth: .infinity).padding(.horizontal, 18).padding(.top, 100)
                            } else if conversation.messages.isEmpty {
                                VStack(spacing: 15) {
                                    Image(systemName: store.isTemporarySession ? "plus.bubble" : "sparkles")
                                        .font(.system(size: 30, weight: .light)).foregroundStyle(.secondary)
                                    Text(store.isTemporarySession ? "临时聊天" : "开始对话").font(.title3.weight(.medium))
                                    if store.isTemporarySession {
                                        Text("关闭此聊天或退出应用后会消失。")
                                            .font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center)
                                    }
                                }.frame(maxWidth: .infinity).padding(.horizontal, 18)
                                    .padding(.top, store.isTemporarySession ? max(80, (height - top - composerHeight) / 2 - 80) : 130)
                            }
                            if !store.historyLoading, store.hasEarlierMessages {
                                Button {
                                    Task { await loadEarlierHistory() }
                                } label: {
                                    Group {
                                        if store.loadingEarlier { ProgressView() }
                                        else { Text("更早消息").font(.footnote).foregroundStyle(.secondary) }
                                    }.frame(maxWidth: .infinity).padding(.vertical, 8)
                                }.buttonStyle(.plain).disabled(store.loadingEarlier).padding(.horizontal, 18)
                            }
                            ForEach(store.historyLoading ? [] : conversation.messages) { message in
                                VStack(alignment: .leading, spacing: 16) {
                                    if message.role == .user {
                                        Text(messageTimestamp(message.createdAt))
                                            .font(.system(size: 11)).foregroundStyle(.secondary)
                                            .frame(maxWidth: .infinity, alignment: .center)
                                            .accessibilityIdentifier("message-send-time-\(message.id.uuidString)")
                                    }
                                    messageRow(message, conversationID: conversation.id)
                                }
                                .padding(.horizontal, 16) // 气泡外沿与顶部按钮外沿对齐
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .id(message.id)
                                     
                            }
                        }
                    }
                    .scrollTargetLayout()
                    .background(AgentReasoningBackdropProbe(source: reasoningBackdropSource))
                    .containerRelativeFrame(.horizontal, alignment: .leading)
                    .padding(.top, top + 78)
                     
                     
                    .padding(.bottom, 40)
                    .id(store.selectedID)
                    .transition(!newChatSwitchInFlight ? .identity : reduceMotion ? .opacity : .asymmetric(
                        insertion: .offset(y: 62).combined(with: .opacity),
                        removal: .offset(y: -92).combined(with: .opacity)))
                    .background {
                        AgentReasoningPullObserver(presentation: reasoningPresentation,
                                                 enabled: canPullNewChat, topExclusion: top + 72,
                                                 conversationID: store.selectedID,
                                                 began: beginNewChatPull,
                                                 changed: updateNewChatPull,
                                                 ended: finishNewChatPull)
                    }
                }
                .scrollIndicators(.hidden)
                .scrollPosition($chatScrollPosition)
                .defaultScrollAnchor(.bottom, for: .initialOffset)
                .scrollDisabled(dragOrigin != nil || newChatSwitchInFlight)
                .scrollBounceBehavior(.always, axes: .vertical)
                .scrollDismissesKeyboard(.interactively)
                .contentShape(Rectangle())
                 
                 
                 
                 
                .scrollEdgeEffectStyle(.soft, for: .top)
                .scrollEdgeEffectStyle(.soft, for: .bottom)
                .modifier(AgentReasoningScrollEdge(presentation: reasoningPresentation))
                 
                 
                 
                 
                 
                .safeAreaBar(edge: .top, spacing: -(top + 3 + 46 + topBlurEarlyLead)) {
                HStack {
                    if store.isTemporarySession {
                        ShiyanCloseButton(action: { dismiss() }, diameter: ShiyanPreviewLayout.controlDiameter)
                    } else {
                        AgentSidebarButton(hasUnread: store.conversations.contains { $0.hasUnread }, diameter: 46) { setDrawer(true) }
                    }
                    Spacer()
                    if store.isTemporarySession {
                        Text("临时聊天").font(.system(size: 17, weight: .semibold))
                        Spacer()
                    }
    #if DEBUG
                    if ProcessInfo.processInfo.environment["SHIYAN_UI_TEST_EDIT_BRANCH"] == "1" {
                        Button("编辑回归测试") {
                            guard let item = store.current,
                                  let old = item.messages.first(where: { $0.text == "编辑目标_旧文本" }) else { return }
                            beginEditing(old, conversationID: item.id)
                        }
                        .accessibilityIdentifier("test-edit-branch-action")
                    }
    #endif
                    HStack(spacing: 2) {
                        if !store.isTemporarySession {
                        Button {
                            speech.cancel(); speechConversationID = nil; editedMessageID = nil
                            resetConversationPresentation()
                            store.newConversation(); inputText = ""
                            UIImpactFeedbackGenerator(style: .soft).impactOccurred()
                        } label: {
                            Image(systemName: "square.and.pencil").font(.system(size: 21, weight: .medium)).frame(width: 46, height: 46).contentShape(Rectangle())
                        }.buttonStyle(.plain).accessibilityLabel("新建聊天")
                        }
                        ShiyanMoreMenu(hasGlass: false) {
                            Button("扫一扫", systemImage: "qrcode.viewfinder") {
                                speech.cancel(); inputFocused = false
                                showingScanner = true
                            }
                            .accessibilityIdentifier("agent-chat-qr-scanner")
                            if !store.isTemporarySession {
                                Button("临时聊天", systemImage: "plus.bubble") {
                                    speech.cancel(); inputFocused = false
                                    temporaryStore = AgentStore(temporary: true)
                                    showingTemporaryChat = true
                                }
                            }
                            Button("执行过程", systemImage: "list.bullet.rectangle") { showingExecutionHistory = true }
                                .disabled(!(current?.messages.contains { $0.role == .assistant } ?? false))
                        }
                        .menuOrder(.fixed)
                        .accessibilityIdentifier("agent-chat-more")
                    }
                    .padding(.horizontal, 3).foregroundStyle(.primary)
                    .shiyanGlass(in: Capsule(), tint: .white.opacity(0.04), interactive: true)
                }.padding(.horizontal, 16).padding(.top, top + 3)
                .padding(.bottom, topBlurEarlyLead)
                 
                 
                 
                 
                .background(alignment: .bottom) {
                    Text("X")
                        .font(.system(size: 12))
                        .blendMode(.sourceAtop)
                        .allowsHitTesting(false)
                        .accessibilityHidden(true)
                }
                }
                 
                 
                .onScrollPhaseChange { _, phase in
                     
                     
                     
                    scrollIsUserDriven = phase == .interacting || phase == .decelerating
                    traceChatScroll("phase-\(phase)")
                }
#if DEBUG
                .onScrollGeometryChange(for: [CGFloat].self) { value in
                    [value.contentOffset.y, value.containerSize.height, value.contentSize.height, value.contentInsets.top, value.contentInsets.bottom]
                } action: { _, values in
                    if ProcessInfo.processInfo.environment["SHIYAN_UI_TEST_CHAT_REPAIR"] != nil {
                        let record: [String: Any] = ["geometry": values.map { Double($0) }, "following": followLatest, "atLatest": atLatest, "userDriven": scrollIsUserDriven]
                        let url = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("chat-repair-scroll.json")
                        if let data = try? JSONSerialization.data(withJSONObject: record) { try? data.write(to: url, options: .atomic) }
                    }
                }
#endif
                .onScrollGeometryChange(for: Bool.self) { value in
                    value.contentOffset.y + value.contentInsets.top < 120
                } action: { _, nearTop in
                    if nearTop, scrollIsUserDriven, !pagingHistory, store.hasEarlierMessages {
                        Task { await loadEarlierHistory() }
                    }
                }
                .onScrollGeometryChange(for: Bool.self) { value in
                    value.contentOffset.y + value.containerSize.height >= value.contentSize.height - 100
                } action: { _, latest in
                    atLatest = latest; store.viewingLatest = latest
                     
                     
                    if scrollIsUserDriven { followLatest = latest }
                    traceChatScroll("geometry-latest-\(latest)")
                    if latest, let id = store.selectedID { store.viewedLatest(id) }
                }
                .onChange(of: store.selectedID) { _, id in
                    chatScrollPosition = ScrollPosition(edge: .bottom)
                    copyFeedbackTask?.cancel(); copyFeedbackTask = nil; copiedMessageID = nil
                    if !newChatSwitchInFlight { cancelNewChatPull() }
                    attachmentOpen = false
                    inputText = store.current?.draft ?? ""
                    store.visibleConversationID = drawer == 0 ? id : nil
                    atLatest = true; followLatest = true; store.viewingLatest = true
                    bottomScrollRequest += 1
                    if let id { store.viewedLatest(id) }
                }
                .onChange(of: current?.messages.count) { _, _ in
                    guard !pagingHistory else { return }
                    if current?.messages.last?.state == .submitting { followLatest = true }
                    if followLatest, !(current?.messages.isEmpty ?? true) { bottomScrollRequest += 1 }
                }
                .onChange(of: current?.messages.last?.text) { _, _ in
                    if followLatest, !(current?.messages.isEmpty ?? true) { bottomScrollRequest += 1 }
                }
                .onChange(of: current?.messages.last?.assets.count) { _, _ in
                    if followLatest, !(current?.messages.isEmpty ?? true) { bottomScrollRequest += 1 }
                }
                .onChange(of: liveInputRequests) { _, _ in
                    if followLatest, !(current?.messages.isEmpty ?? true) { bottomScrollRequest += 1 }
                }
                .onAppear { bottomScrollRequest += 1 }
                .task(id: bottomScrollRequest) {
                     
                     
                    await Task.yield()
                    guard !Task.isCancelled, !(current?.messages.isEmpty ?? true), followLatest, !scrollIsUserDriven, newChatPull.distance == 0 else { traceChatScroll("skip-follow-request"); return }
                    if keyboardTransitionInFlight {
                        deferredMessageScroll = true
                        return
                    }
                    deferredMessageScroll = false
                    traceChatScroll("perform-bottom-request")
                    var transaction = Transaction(); transaction.animation = nil
                    withTransaction(transaction) { chatScrollPosition.scrollTo(edge: .bottom) }
                }
                .overlay(alignment: .bottom) {
                    let showsBottomButton = !atLatest && !(current?.messages.isEmpty ?? true)
                    Button {
                        followLatest = true; scrollIsUserDriven = false
                        traceChatScroll("bottom-button-tapped")
                        bottomScrollRequest += 1
                    } label: {
                        Image(systemName: "arrow.down").font(.system(size: 16, weight: .medium))
                            .frame(width: 36, height: 36).shiyanGlass(in: Circle())
                            .contentShape(Circle())
                    }.buttonStyle(.plain).accessibilityLabel("查看最新消息")
                        .accessibilityIdentifier("chat-scroll-bottom")
                        .modifier(AgentReasoningVisibility(presentation: reasoningPresentation))
                         
                         
                        .offset(y: -8)
                        .opacity(showsBottomButton ? 1 : 0)
                        .offset(y: reduceMotion || showsBottomButton ? 0 : 8)
                    .allowsHitTesting(showsBottomButton)
                    .accessibilityHidden(!showsBottomButton)
                    .animation(reduceMotion ? .easeOut(duration: 0.16) : .easeInOut(duration: 0.28), value: showsBottomButton)
                }
            }
             
             
             
        }.safeAreaBar(edge: .bottom, spacing: 0) {
             
             
             
            composer
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { value in
                let settledHeight = value.rounded()
                if abs(settledHeight - composerHeight) >= 2 { composerHeight = settledHeight }
            }
        }
         
         
         
        .safeAreaInset(edge: .bottom, spacing: 0) {
            Color.clear.frame(height: composerBottom)
                .allowsHitTesting(false)
                .accessibilityHidden(true)
        }.coordinateSpace(name: "agentViewport")
    }

    private func beginNewChatPull() {
        guard !reasoningPresentation.isOpen, canPullNewChat else { return }
        cancelNewChatPull(animated: false)
        pullConversationID = store.selectedID
        pullReadyFeedback.prepare()
        pullCommitFeedback.prepare()
    }

    private func updateNewChatPull(_ distance: CGFloat) {
        guard !reasoningPresentation.isOpen, canPullNewChat, pullConversationID == store.selectedID else { cancelNewChatPull(); return }
        var next = newChatPull
        let giveReadyFeedback = next.update(distance: Double(distance))
        var transaction = Transaction(); transaction.animation = nil
        withTransaction(transaction) { newChatPull = next }
        if next.isArmed != newChatReadyVisual {
            withAnimation(reduceMotion ? .easeOut(duration: 0.12) :
                            .spring(response: 0.28, dampingFraction: 0.57, blendDuration: 0.08)) {
                newChatReadyVisual = next.isArmed
            }
        }
        if giveReadyFeedback {
            pullReadyFeedback.impactOccurred(intensity: 0.78)
            pullCommitFeedback.prepare()
        }
    }

    private func cancelNewChatPull(animated: Bool = true) {
        pullConversationID = nil
        guard newChatPull.distance > 0 || newChatReadyVisual else { return }
        withAnimation(animated ? (reduceMotion ? .easeOut(duration: 0.12) :
                                    .spring(response: 0.34, dampingFraction: 0.84)) : nil) {
            newChatPull = AgentNewChatPullState()
            newChatReadyVisual = false
        }
    }

    private func finishNewChatPull(_ cancelled: Bool) {
        guard !reasoningPresentation.isOpen, !newChatSwitchInFlight, canPullNewChat,
              pullConversationID == store.selectedID, !(current?.messages.isEmpty ?? true) else {
            cancelNewChatPull(); return
        }
        var next = newChatPull
        guard next.finish(cancelled: cancelled) else { cancelNewChatPull(); return }
        pullConversationID = nil
        pullCommitFeedback.impactOccurred(intensity: 0.9)
        speech.cancel(); speechConversationID = nil
        editedMessageID = nil
        previousDraftBeforeEdit = nil; previousAssetsBeforeEdit = nil
        inputFocused = false
        scrollIsUserDriven = false
        followLatest = true; atLatest = true
         
        withAnimation(reduceMotion ? .easeOut(duration: 0.18) :
                        .spring(response: 0.42, dampingFraction: 0.86)) {
            newChatSwitchInFlight = true
            newChatPull = next
            newChatReadyVisual = false
            store.newConversation(reuseExistingEmpty: true)
            inputText = store.current?.draft ?? ""
        }
        newChatSwitchTask?.cancel()
        newChatSwitchTask = Task { @MainActor in
            do { try await Task.sleep(for: .milliseconds(480)) } catch { return }
            guard !Task.isCancelled else { return }
            newChatSwitchInFlight = false
            newChatSwitchTask = nil
        }
    }

    private func beginEditing(_ message: AgentMessage, conversationID: UUID) {
        guard message.role == .user, !editInFlight else { return }
        if editedMessageID == nil {
            previousDraftBeforeEdit = inputText
            previousAssetsBeforeEdit = store.conversation(conversationID)?.draftAssets
        }
        inputText = message.text
        store.setDraft(message.text)
        store.setDraftAssets(message.assets, in: conversationID)
        editedMessageID = message.id
        inputFocused = true
    }

     
     
     
    private func userMessageBubble(_ text: String, selectionIdentifier: String? = nil, previewLineLimit: Int? = nil) -> some View {
        let shape = RoundedRectangle(cornerRadius: 20, style: .continuous)
         
        return Text(text)
            .opacity(selectionIdentifier == nil ? 1 : 0)
            .accessibilityHidden(selectionIdentifier != nil)
            .overlay(alignment: .topLeading) {
                if let selectionIdentifier {
                    AgentSelectableText(text: text, selectOnAppear: true,
                                        selectionRequestID: inlineSelectionRequestID, identifier: selectionIdentifier,
                                        onSelectionChanged: { selecting in inlineSelectionActive = selecting; if selecting { followLatest = false } })
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                }
            }
            .font(.body)
            .lineSpacing(5)
            .lineLimit(previewLineLimit)
            .truncationMode(.tail)
            .fixedSize(horizontal: false, vertical: true)
            .padding(13)
            .background {
                shape
                     
                    .fill(colorScheme == .dark ? Color(white: 0.065) : Color.white)
                    .overlay {
                        shape.fill(Color.accentColor.opacity(0.09))
                    }
            }
            .clipShape(shape)
    }

     
     
    private func messageTimestamp(_ date: Date, relativeTo now: Date = Date(), calendar: Calendar = .current) -> String {
        let prefix: String
        if calendar.isDate(date, inSameDayAs: now) {
            prefix = "今天"
        } else if let yesterday = calendar.date(byAdding: .day, value: -1, to: now),
                  calendar.isDate(date, inSameDayAs: yesterday) {
            prefix = "昨天"
        } else {
            let day = calendar.component(.day, from: date)
            let month = calendar.component(.month, from: date)
            let year = calendar.component(.year, from: date)
            prefix = calendar.component(.year, from: now) == year
                ? "\(month)月\(day)日"
                : "\(year)年\(month)月\(day)日"
        }
        let clock = DateFormatter()
        clock.locale = Locale(identifier: "zh_CN")
        clock.calendar = calendar
        clock.timeZone = calendar.timeZone
        clock.dateFormat = "HH:mm"
        return prefix + " " + clock.string(from: date)
    }

    private func messageRow(_ message: AgentMessage, conversationID: UUID) -> some View {
        let visibleAssets = message.assets
        return HStack(alignment: .top, spacing: 0) {
            if message.role == .user { Spacer(minLength: 36) }
            VStack(alignment: message.role == .user ? .trailing : .leading, spacing: 12) {
                if !visibleAssets.isEmpty {
                    if visibleAssets.count == 1, let asset = visibleAssets.first {
                        assetCard(asset, conversationID: conversationID)
                    } else {
                        LazyVGrid(columns: [GridItem(.flexible(), spacing: 10), GridItem(.flexible(), spacing: 10)], spacing: 10) {
                            ForEach(visibleAssets) { asset in assetCard(asset, conversationID: conversationID) }
                        }
                    }
                }
                if message.role == .assistant, message.state == .completed, let completed = message.completedAt {
                    Text("已处理 " + processingTime(message, at: completed))
                        .font(.caption).foregroundStyle(.secondary).monospacedDigit()
                }
                if !message.text.isEmpty {
                    if message.role == .user {
                        userMessageBubble(message.text, selectionIdentifier: inlineSelectionMessageID == message.id ? "user-selection-\(message.id.uuidString)" : nil)
                            .contentShape(.interaction, RoundedRectangle(cornerRadius: 20, style: .continuous))
                            .accessibilityIdentifier("user-bubble-\(message.id.uuidString)")
                            .contentShape(.contextMenuPreview,
                                          RoundedRectangle(cornerRadius: 20, style: .continuous))
                            .agentLongPressMenu(isLong: AgentLongMessage.isLong(message.text)) {
                                Section {
                                    Button {
                                        UIPasteboard.general.string = message.text
                                    } label: { Label { Text("复制") } icon: { Image(uiImage: AgentCopyStyle.menuImage) } }
                                    Button {
                                        beginEditing(message, conversationID: conversationID)
                                    } label: { Label { Text("编辑") } icon: { Image(uiImage: AgentMenuIcons.rename).resizable().frame(width: 20, height: 20) } }
                                    Button { inlineSelectionMessageID = message.id; inlineSelectionRequestID += 1; followLatest = false } label: {
                                        Label("选择文本", systemImage: "text.viewfinder")
                                    }
                                } header: {
                                    Text(messageTimestamp(message.createdAt))
                                        .font(.system(size: 11, weight: .regular))
                                        .foregroundStyle(.tertiary)
                                }
                            } preview: {
                                userMessageBubble(message.text, selectionIdentifier: nil)
                                    .frame(maxWidth: .infinity, alignment: .trailing).padding(12)
                            }
                    } else {
                        AgentMarkdown(text: message.presentationText, identifier: "assistant-text-\(message.id.uuidString)", onSelectionChanged: { selecting in
                            if selecting { followLatest = false }
                            else if atLatest { followLatest = true }
                        })
                            .transaction { $0.animation = nil }
                    }
                }
                if message.role == .assistant,
                   store.conversation(conversationID)?.messages.last?.id == message.id {
                    liveQuestionForms(message: message, conversationID: conversationID)
                }
                if message.isWorking { AgentActivityView(message: message) }
                if let error = message.presentationError { Text(error).font(.subheadline).foregroundStyle(.red).textSelection(.enabled) }
                if message.state == .cancelled { Text(message.phase.isEmpty ? "已停止" : message.phase).font(.caption).foregroundStyle(.secondary) }
                if message.role == .assistant {
                    if message.state == .completed && message.text.isEmpty && message.assets.isEmpty {
                        Text("本轮已结束，未返回可展示内容").font(.subheadline).foregroundStyle(.secondary)
                    }
                }
                if message.role == .assistant,
                   (!message.isWorking || message.canRetryConnection),
                   (!message.presentationText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || message.canRetryConnection) {
                    HStack(spacing: 0) {
                    Button {
                        copyAssistantReply(message)
                    } label: {
                        Group {
                            if copiedMessageID == message.id {
                                Image(systemName: "checkmark").font(.system(size: 15, weight: .medium))
                            } else {
                                AgentReplyCopyIcon()
                                    .stroke(style: StrokeStyle(lineWidth: 1.5, lineCap: .round, lineJoin: .round))
                                    .frame(width: 15.1, height: 15.1)
                            }
                        }
                        .frame(width: 16, height: 16)
                        .foregroundStyle(colorScheme == .dark ? Color(white: 0.68) : Color(white: 93.0 / 255))
                        .contentTransition(.opacity)
                        .frame(width: 44, height: 44, alignment: .leading)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                     
                    .padding(.top, -8)
                    .accessibilityLabel(copiedMessageID == message.id ? "已复制回复" : "复制回复")
                    .accessibilityIdentifier("assistant-copy-\(message.id.uuidString)")
                    .disabled(message.presentationText.isEmpty)
                    if message.canRetryConnection, store.conversation(conversationID)?.messages.last?.id == message.id {
                        Button { store.retryDelivery(conversationID, messageID: message.id) } label: {
                            Image(systemName: "arrow.clockwise")
                                .resizable().scaledToFit().frame(width: 15.1, height: 15.1)
                                .foregroundStyle(colorScheme == .dark ? Color(white: 0.68) : Color(white: 93.0 / 255))
                                .frame(width: 16, height: 16)
                                .frame(width: 44, height: 44, alignment: .leading)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain).padding(.top, -8)
                        .accessibilityLabel("重试")
                        .accessibilityIdentifier("assistant-retry-\(message.id.uuidString)")
                    }
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: message.role == .user ? .trailing : .leading)
            if message.role == .assistant { Spacer(minLength: 12) }
        }
        .frame(maxWidth: .infinity, alignment: message.role == .user ? .trailing : .leading)
    }
    private func copyAssistantReply(_ message: AgentMessage) {
        UIPasteboard.general.string = message.presentationText
        copiedMessageID = message.id
        copyFeedbackTask?.cancel()
        copyFeedbackTask = Task { @MainActor in
            do { try await Task.sleep(for: .milliseconds(1400)) } catch { return }
            guard !Task.isCancelled, copiedMessageID == message.id else { return }
            copiedMessageID = nil
            copyFeedbackTask = nil
        }
    }

    private func processingTime(_ message: AgentMessage, at date: Date) -> String {
        let seconds = max(0, Int(date.timeIntervalSince(message.createdAt)))
        if seconds < 60 { return "\(seconds)s" }
        if seconds >= 3600 {
            return String(format: "%dh %02dm %02ds", seconds / 3600, (seconds % 3600) / 60, seconds % 60)
        }
        return String(format: "%dm %02ds", seconds / 60, seconds % 60)
    }

    private func assetCard(_ asset: AgentAsset, conversationID: UUID) -> some View {
        Button {
            if asset.isImage, AgentMedia.image(asset) == nil {
                imageLoadErrors[asset.id] = nil; imageLoadRequest += 1
            } else { preview = asset }
        } label: {
            Group {
                if asset.isImage, let image = AgentMedia.image(asset) {
                    Image(uiImage: image).resizable().scaledToFit().frame(maxHeight: 350)
                        .clipShape(RoundedRectangle(cornerRadius: 19, style: .continuous))
                        .contentShape(.contextMenuPreview, RoundedRectangle(cornerRadius: 19, style: .continuous))
                } else if asset.isImage {
                    HStack(spacing: 10) {
                        if imageLoadErrors[asset.id] == nil { ProgressView() }
                        Text(imageLoadErrors[asset.id] == nil ? "正在加载图片…" : "图片加载失败，点按重试")
                            .font(.subheadline).foregroundStyle(.secondary)
                    }.frame(maxWidth: .infinity, minHeight: 160)
                        .background(Color.primary.opacity(0.055), in: RoundedRectangle(cornerRadius: 19))
                } else {
                    HStack(spacing: 10) { Image(systemName: "doc").font(.title2); Text(asset.filename).font(.subheadline).lineLimit(2); Spacer() }
                        .padding(16).background(Color.primary.opacity(0.055), in: RoundedRectangle(cornerRadius: 16))
                }
            }
        }
        .task(id: "\(asset.id)-\(imageLoadRequest)") {
            guard asset.isImage, let key = asset.syncAssetID,
                  AgentMedia.image(asset) == nil else { return }
            do {
                imageLoadErrors[asset.id] = nil
                let bytes = try await CodexClient.shared.syncAsset(id: key)
                guard UIImage(data: bytes) != nil else { throw AgentClientError.message("图片数据不完整") }
                try await Task.detached(priority: .utility) {
                    try FileManager.default.createDirectory(at: AgentMedia.directory, withIntermediateDirectories: true)
                    try bytes.write(to: asset.url, options: .atomic)
                }.value
                store.objectWillChange.send()
                await store.collectGeneratedImages()
                imageLoadErrors[asset.id] = nil
            } catch {
                if !Task.isCancelled { imageLoadErrors[asset.id] = error.localizedDescription }
            }
        }
        .buttonStyle(.plain).accessibilityLabel(asset.isImage ? "查看图片" : "查看文件：\(asset.filename)")
         
        .contentShape(.contextMenuPreview, RoundedRectangle(cornerRadius: asset.isImage ? 19 : 16, style: .continuous))
        .contextMenu {
            if asset.isImage {
                Button { store.useImage(asset, in: conversationID); inputFocused = true } label: { Label("使用这张图片", systemImage: "photo") }
                Button { if let image = UIImage(contentsOfFile: asset.url.path) { Task { if !(await PhotoSaver.save(image)) { store.notice = "保存失败，请检查相册权限" } } } } label: { Label("保存图片", systemImage: "square.and.arrow.down") }
            }
            ShareLink(item: asset.url) { Label("分享", systemImage: "square.and.arrow.up") }
        }
    }

    private var attachmentCard: some View {
        VStack(spacing: 4) {
            attachmentRow("相机", symbol: "camera") { openAttachment(.camera) }
            attachmentRow("照片", symbol: "photo") { openAttachment(.photos) }
            attachmentRow("文件", symbol: "paperclip") { openAttachment(.files) }
        }
        .padding(10)
        .frame(width: 248)
        .shiyanGlass(in: RoundedRectangle(cornerRadius: 32, style: .continuous))
        .shadow(color: .black.opacity(0.10), radius: 24, x: 0, y: 10)
        .accessibilityIdentifier("agent-attachment-card")
    }

    private func attachmentRow(_ title: String, symbol: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 18) {
                AgentAttachmentIcon(symbol: symbol)
                    .stroke(Color.primary, style: StrokeStyle(lineWidth: 2.2, lineCap: .round, lineJoin: .round))
                    .frame(width: 24, height: 24)
                    .frame(width: 44, height: 44)
                    .background(Color.primary.opacity(0.045), in: Circle())
                Text(title).font(.system(size: 19))
                Spacer(minLength: 0)
            }.foregroundStyle(.primary).padding(.horizontal, 12).frame(height: 64)
                .contentShape(Rectangle())
        }.buttonStyle(.plain)
    }

    private enum AttachmentSource { case camera, photos, files }
    private func closeAttachments() {
        withAnimation(reduceMotion ? nil : .easeOut(duration: 0.18)) { attachmentOpen = false }
    }
    private func openAttachment(_ source: AttachmentSource) {
        guard let id = store.selectedID else { return }
        closeAttachments()
        guard (current?.draftAssets.count ?? 0) < store.capabilities.maxUploadImages else {
            store.notice = "请先移除部分附件，再继续添加"; return
        }
        attachmentConversationID = id
        inputFocused = false
        switch source {
        case .photos: showPhotos = true
        case .files: showFiles = true
        case .camera:
            guard UIImagePickerController.isSourceTypeAvailable(.camera) else {
                store.notice = "当前设备无法使用相机"; return
            }
            Task { @MainActor in
                let status = AVCaptureDevice.authorizationStatus(for: .video)
                var allowed = status == .authorized
                if status == .notDetermined { allowed = await AVCaptureDevice.requestAccess(for: .video) }
                if allowed { showCamera = true }
                else { store.notice = "请在系统设置中允许拾燕访问相机" }
            }
        }
    }
    private func importFiles(_ result: Result<[URL], Error>) {
        guard let id = attachmentConversationID else { return }
        do {
            let urls = try result.get()
            let available = store.capabilities.maxUploadImages - (store.conversation(id)?.draftAssets.count ?? 0)
            guard urls.count <= available else { throw AgentClientError.message("选择的附件过多，请减少后重试") }
            var assets: [AgentAsset] = []
            for url in urls {
                let granted = url.startAccessingSecurityScopedResource()
                defer { if granted { url.stopAccessingSecurityScopedResource() } }
                let info = try url.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey, .contentTypeKey])
                guard info.isRegularFile == true else { throw AgentClientError.message("请选择文件，暂不支持文件夹") }
                guard (info.fileSize ?? 0) <= 10 * 1024 * 1024 else { throw AgentClientError.message("单个文件不能超过 10 MB") }
                let data = try Data(contentsOf: url)
                guard data.count <= 10 * 1024 * 1024 else { throw AgentClientError.message("单个文件不能超过 10 MB") }
                if let image = UIImage(data: data) {
                    assets.append(try AgentMedia.saveImage(image))
                } else {
                    assets.append(try AgentMedia.save(data, filename: url.lastPathComponent,
                                                     mimeType: (info.contentType?.preferredMIMEType?.hasPrefix("image/") == false ? info.contentType?.preferredMIMEType : nil) ?? "application/octet-stream"))
                }
            }
            store.addDraftAssets(assets, to: id)
        } catch { store.notice = error.localizedDescription }
    }

    private var composer: some View {
        VStack(spacing: 8) {
            if let conversation = current {
                if editedMessageID != nil {
                    HStack {
                        Text(editInFlight ? "正在准备编辑分支…" : "编辑后重新发送").font(.caption).foregroundStyle(.secondary)
                        Spacer()
                        Button {
                            editedMessageID = nil
                            inputText = previousDraftBeforeEdit ?? ""
                            store.setDraft(inputText)
                            if let id = store.selectedID {
                                store.setDraftAssets(previousAssetsBeforeEdit ?? [], in: id)
                            }
                            previousDraftBeforeEdit = nil
                            previousAssetsBeforeEdit = nil
                        } label: { Image(systemName: "xmark") }
                        .accessibilityLabel("取消编辑")
                        .disabled(editInFlight)
                    }.padding(.horizontal, 12)
                        .modifier(AgentReasoningVisibility(presentation: reasoningPresentation))
                }
                let attachments = conversation.draftAssets
                let hasMessageToSend = !inputText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !attachments.isEmpty
                // 发送后到服务器确认之间，同步可能短暂把“处理中”覆盖成旧值；有待回复的消息就继续显示停止按钮，避免图标来回闪。
                let showStop = conversation.isBusy || conversation.pendingMessageID != nil
                let waitingForMessage = !showStop &&
                    inputText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
                    attachments.isEmpty
                let expanded = inputFocused || speech.isRecording || !attachments.isEmpty
                VStack(spacing: 0) {
                    if let queue = conversation.messageQueue, !queue.isEmpty {
                        ScrollView {
                            VStack(spacing: 8) {
                                ForEach(Array(queue.enumerated()), id: \.element.id) { index, entry in
                                    HStack(spacing: 8) {
                                        Text(entry.urgent ? "优先等待" : "等待 \(index + 1)")
                                            .font(.caption).foregroundStyle(.secondary)
                                        Text(entry.text.isEmpty ? "附件消息" : entry.text)
                                            .font(.subheadline).lineLimit(2).frame(maxWidth: .infinity, alignment: .leading)
                                        Button { store.prioritizeQueuedMessage(entry.id, in: conversation.id) } label: {
                                            Image(systemName: "arrow.turn.down.left").frame(width: 32, height: 32)
                                        }.buttonStyle(.plain).disabled(entry.urgent)
                                            .accessibilityLabel("优先处理这条等待消息")
                                        Button { store.removeQueuedMessage(entry.id, in: conversation.id) } label: {
                                            Image(systemName: "xmark").frame(width: 32, height: 32)
                                        }.buttonStyle(.plain).accessibilityLabel("移除等待消息")
                                    }
                                }
                                if let error = conversation.queueError {
                                    Text(error).font(.caption).foregroundStyle(.secondary)
                                }
                            }.padding(10)
                        }.frame(maxHeight: min(CGFloat(queue.count) * 56 + (conversation.queueError == nil ? 0 : 30), 160))
                    }
                    if !attachments.isEmpty {
                        ScrollView(.horizontal) {
                            HStack(spacing: 10) {
                                ForEach(attachments) { asset in
                                    if !asset.isImage {
                                        HStack(spacing: 8) {
                                            Image(systemName: "doc").font(.system(size: 22))
                                            Text(asset.filename).font(.caption).lineLimit(2).frame(maxWidth: 120)
                                            Button { store.removeDraftAsset(asset.id, in: conversation.id) } label: {
                                                Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary)
                                            }.accessibilityLabel("移除文件：\(asset.filename)")
                                        }.padding(10).frame(height: 56)
                                            .background(Color.primary.opacity(0.055), in: RoundedRectangle(cornerRadius: 12))
                                    } else if let image = AgentMedia.image(asset, maxPixel: 300) {
                                        Image(uiImage: image).resizable().scaledToFill().frame(width: 96, height: 96).clipShape(RoundedRectangle(cornerRadius: 14))
                                            .contentShape(RoundedRectangle(cornerRadius: 14))
                                            .onTapGesture { inputFocused = false; preview = asset }
                                            .accessibilityLabel("查看上传图片")
                                            .accessibilityAddTraits(.isButton)
                                            .overlay(alignment: .topTrailing) {
                                                Button { store.removeDraftAsset(asset.id, in: conversation.id) } label: { Image(systemName: "xmark.circle.fill").symbolRenderingMode(.palette).foregroundStyle(.white, .black.opacity(0.7)) }.offset(x: 5, y: -5)
                                            }
                                    }
                                }
                            }.padding(6)
                        }.scrollIndicators(.hidden).frame(height: 110)
                            .modifier(AgentReasoningVisibility(presentation: reasoningPresentation))
                    }
                    AgentReasoningMessageField(presentation: reasoningPresentation,
                                               text: $inputText, focused: $inputFocused)
                        .lineLimit(1...(expanded ? 6 : 1))
                        .padding(.leading, expanded ? 8 : 43)
                        .padding(.trailing, expanded ? 8 : 98)
                        .padding(.top, expanded ? 10 : 0)
                        .padding(.bottom, expanded ? 49 : 0)
                        .frame(minHeight: expanded ? 86 : 44, alignment: expanded ? .topLeading : .leading)
                        .accessibilityIdentifier("agent-message-input")
                        .disabled(editInFlight)
                }
                .overlay(alignment: .bottom) {
                    HStack(spacing: 8) {
                        Button {
                            speech.stop()
                            reasoningPresentation.close()
                            attachmentButtonFrame = attachmentAnchor.frame
                            withAnimation(reduceMotion ? nil : .easeOut(duration: 0.18)) { attachmentOpen.toggle() }
                        } label: {
                            Image(systemName: "plus").font(.system(size: 22)).frame(width: 34, height: 40).contentShape(Rectangle())
                        }.buttonStyle(.plain).accessibilityLabel("添加附件")
                            .accessibilityIdentifier("agent-add-attachment")
                            .disabled(loadingPhotos)
                            .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { frame in
                                attachmentAnchor.frame = frame
                                if attachmentOpen, attachmentButtonFrame != frame { attachmentButtonFrame = frame }
                            }
                        Spacer(minLength: 2)
                        if inputFocused {
                            Button {
                                if speech.isRecording || speech.isStarting { speech.stop() }
                                if attachmentOpen { attachmentOpen = false }
                                 
                                 
                                reasoningPresentation.open()
                            } label: {
                                // 直接显示当前模型名和推理强度，点开可切换。
                                Text(store.selectedModel.displayName.replacingOccurrences(of: "Claude ", with: "") + " · " + reasoningTitle(conversation.reasoning))
                                    .font(.system(size: 12, weight: .medium)).lineLimit(1).fixedSize()
                                    .foregroundStyle(Color.accentColor)
                                    .padding(.horizontal, 10).frame(height: 28)
                                    .background(Color.accentColor.opacity(0.12), in: Capsule())
                                    .frame(height: 40).contentShape(Rectangle())
                            }.buttonStyle(.plain)
                                .accessibilityLabel("模型与推理：\(store.selectedModel.displayName)，\(reasoningTitle(conversation.reasoning))")
                                .accessibilityIdentifier("agent-animated-small-gauge")
                        }
                        Button {
                            if speech.isRecording { speech.stop() }
                            else if !speech.isStarting { dotsVoice.end(); speechBase = inputText; speechConversationID = conversation.id; Task { await speech.start() } }
                        } label: {
                            Image(systemName: speech.isRecording ? "stop.fill" : "mic").font(.system(size: 20))
                                .foregroundStyle(speech.isRecording ? Color.red : Color.primary).frame(width: 36, height: 40).contentShape(Rectangle())
                        }.buttonStyle(.plain).accessibilityLabel(speech.isRecording ? "结束语音输入" : "语音转文字")
                        Button {
                            guard let latest = store.current else { return }
                            if (latest.isBusy || latest.pendingMessageID != nil) && !hasMessageToSend { Task { await store.stop(latest.id) } }
                            else {
                                let text = inputText
                                let assets = latest.draftAssets
                                guard !editInFlight else { return }
                                speech.cancel(); speechConversationID = nil
                                inputFocused = false; reasoningPresentation.close(); attachmentOpen = false
                                if let messageID = editedMessageID {
                                    let conversationID = latest.id
                                    editInFlight = true
                                    Task {
                                        let accepted = await store.editAndResend(
                                            conversationID: conversationID, messageID: messageID,
                                            text: text, attachments: assets)
                                        editInFlight = false
                                        if accepted && store.selectedID == conversationID {
                                            inputText = ""; editedMessageID = nil; atLatest = true; followLatest = true; bottomScrollRequest += 1
                                            previousDraftBeforeEdit = nil
                                            previousAssetsBeforeEdit = nil
                                        }
                                    }
                                } else {
                                    guard store.send(text: text, attachments: assets) else { return }
                                    inputText = ""; atLatest = true; followLatest = true; bottomScrollRequest += 1
                                }
                            }
                        } label: {
                            Image(systemName: showStop && !hasMessageToSend ? "stop.fill" : "arrow.up")
                                .font(.system(size: showStop && !hasMessageToSend ? 16 : 19, weight: .bold))
                                .contentTransition(.identity)
                                .foregroundStyle(.white)
                                .frame(width: 36, height: 36)
                                .background(Color.accentColor, in: Circle())
                        }.buttonStyle(.plain)
                        .disabled(editInFlight || loadingPhotos || (!showStop && !hasMessageToSend))
                        .animation(nil, value: showStop)
                         
                        .overlay {
                            if waitingForMessage {
                                ZStack {
                                    Circle()
                                        .fill(Color(.sRGB, red: 158.0 / 255, green: 200.0 / 255, blue: 238.0 / 255, opacity: 1))
                                    Image(systemName: "arrow.up")
                                        .font(.system(size: 19, weight: .bold))
                                        .foregroundStyle(Color(.sRGB, red: 244.0 / 255, green: 248.0 / 255, blue: 253.0 / 255, opacity: 1))
                                        .frame(width: 36, height: 36)
                                }
                                .frame(width: 36, height: 36)
                                .allowsHitTesting(false)
                                .accessibilityHidden(true)
                            }
                        }
                        .accessibilityLabel(showStop ? (hasMessageToSend ? "追加问题" : "停止处理") : "发送")
                    }.padding(.horizontal, 5).padding(.bottom, 2)
                        .modifier(AgentReasoningVisibility(presentation: reasoningPresentation))
                }
                .padding(.horizontal, 8).padding(.vertical, 5)
                .frame(maxWidth: expanded ? .infinity : 325)
                .modifier(AgentReasoningComposerSurface(presentation: reasoningPresentation,
                                                       cornerRadius: expanded ? 25 : 29))
                .frame(maxWidth: .infinity)
            }
        }.padding(.horizontal, AgentComposerLayout.gutter).padding(.top, 8)
    }

    private func traceChatScroll(_ event: String) {
#if DEBUG
        guard ProcessInfo.processInfo.environment["SHIYAN_UI_TEST_CHAT_REPAIR"] != nil else { return }
        let url = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("chat-repair-scroll-events.json")
        var records = (try? Data(contentsOf: url)).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [[String: Any]] } ?? []
        records.append(["event": event, "time": Date().timeIntervalSince1970, "following": followLatest, "atLatest": atLatest, "userDriven": scrollIsUserDriven, "request": bottomScrollRequest])
        if let data = try? JSONSerialization.data(withJSONObject: Array(records.suffix(150))) { try? data.write(to: url, options: .atomic) }
#endif
    }

    private func setDrawer(_ open: Bool) {
        guard !store.isTemporarySession || !open else { return }
        dragOrigin = nil
        inputFocused = false; reasoningPresentation.close(); attachmentOpen = false
        withAnimation(reduceMotion ? nil : .interactiveSpring(response: 0.36, dampingFraction: 0.88)) { drawer = open ? 1 : 0 }
        store.visibleConversationID = open || featurePage != nil ? nil : store.selectedID
        if !open && featurePage == nil { UIImpactFeedbackGenerator(style: .soft).impactOccurred(); if let id = store.selectedID { store.viewedLatest(id) } }
    }
    private func finishKeyboardTransition() {
         
         
        guard keyboardTransitionInFlight else { return }
        keyboardTransitionInFlight = false
        let needsMessageScroll = deferredMessageScroll
        deferredMessageScroll = false
        guard needsMessageScroll, featurePage == nil, drawer == 0,
              followLatest, !scrollIsUserDriven, !pagingHistory,
              newChatPull.distance == 0, !(current?.messages.isEmpty ?? true) else { return }
        traceChatScroll("deferred-message-after-keyboard")
        bottomScrollRequest += 1
    }

    private func resetConversationPresentation() {
        reasoningPresentation.close()
        inputFocused = false
        attachmentOpen = false
    }

    private func closeReasoning() {
        reasoningPresentation.close()
    }
    private func updateDrawerDrag(_ translation: CGFloat, width: CGFloat) {
        guard !store.isTemporarySession else { return }
        if dragOrigin == nil {
            dragOrigin = drawer
            inputFocused = false
            reasoningPresentation.close()
            attachmentOpen = false
            store.visibleConversationID = nil
        }
        drawer = min(max((dragOrigin ?? 0) + translation / max(width * 0.75, 1), 0), 1)
    }

    private func finishDrawerDrag(translation: CGFloat, velocity: CGFloat, cancelled: Bool, width: CGFloat) {
        guard let origin = dragOrigin else { return }
        let open: Bool
        if cancelled {
            open = origin >= 0.5
        } else if abs(velocity) >= 350 {
            open = velocity > 0
        } else if abs(translation) >= min(64, width * 0.18) {
            open = translation > 0
        } else {
            open = drawer >= 0.5
        }
        setDrawer(open)
    }
}


struct AgentCameraPicker: UIViewControllerRepresentable {
    let completion: (UIImage?) -> Void
    func makeCoordinator() -> Coordinator { Coordinator(completion: completion) }
    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.cameraCaptureMode = .photo
        picker.delegate = context.coordinator
        return picker
    }
    func updateUIViewController(_ controller: UIImagePickerController, context: Context) {}
    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let completion: (UIImage?) -> Void
        init(completion: @escaping (UIImage?) -> Void) { self.completion = completion }
        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) { completion(nil) }
        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            completion(info[.originalImage] as? UIImage)
        }
    }
}


 
struct AgentAttachmentIcon: Shape {
    let symbol: String
    func path(in rect: CGRect) -> Path {
        var p = Path()
        switch symbol {
        case "camera":
            p.move(to: CGPoint(x: 17, y: 18))
            p.addLine(to: CGPoint(x: 21, y: 11))
            p.addQuadCurve(to: CGPoint(x: 26, y: 8), control: CGPoint(x: 22, y: 8))
            p.addLine(to: CGPoint(x: 38, y: 8))
            p.addQuadCurve(to: CGPoint(x: 43, y: 11), control: CGPoint(x: 42, y: 8))
            p.addLine(to: CGPoint(x: 47, y: 18))
            p.addLine(to: CGPoint(x: 51, y: 18))
            p.addQuadCurve(to: CGPoint(x: 58, y: 25), control: CGPoint(x: 58, y: 18))
            p.addLine(to: CGPoint(x: 58, y: 50))
            p.addQuadCurve(to: CGPoint(x: 51, y: 57), control: CGPoint(x: 58, y: 57))
            p.addLine(to: CGPoint(x: 13, y: 57))
            p.addQuadCurve(to: CGPoint(x: 6, y: 50), control: CGPoint(x: 6, y: 57))
            p.addLine(to: CGPoint(x: 6, y: 25))
            p.addQuadCurve(to: CGPoint(x: 13, y: 18), control: CGPoint(x: 6, y: 18))
            p.closeSubpath()
            p.addEllipse(in: CGRect(x: 20, y: 25, width: 24, height: 24))
        case "photo":
            p.addRoundedRect(in: CGRect(x: 6, y: 8, width: 52, height: 48), cornerSize: CGSize(width: 8, height: 8))
            p.addEllipse(in: CGRect(x: 34, y: 18, width: 12, height: 12))
            p.move(to: CGPoint(x: 7, y: 44))
            p.addLine(to: CGPoint(x: 18, y: 34))
            p.addQuadCurve(to: CGPoint(x: 26, y: 34), control: CGPoint(x: 22, y: 30))
            p.addLine(to: CGPoint(x: 49, y: 56))
        default:
            p.move(to: CGPoint(x: 13, y: 21))
            p.addLine(to: CGPoint(x: 13, y: 43))
            p.addCurve(to: CGPoint(x: 51, y: 43), control1: CGPoint(x: 13, y: 64), control2: CGPoint(x: 51, y: 64))
            p.addLine(to: CGPoint(x: 51, y: 17))
            p.addCurve(to: CGPoint(x: 26, y: 17), control1: CGPoint(x: 51, y: 0), control2: CGPoint(x: 26, y: 0))
            p.addLine(to: CGPoint(x: 26, y: 42))
            p.addCurve(to: CGPoint(x: 39, y: 42), control1: CGPoint(x: 26, y: 51), control2: CGPoint(x: 39, y: 51))
            p.addLine(to: CGPoint(x: 39, y: 17))
        }
        return p.applying(CGAffineTransform(scaleX: rect.width / 64, y: rect.height / 64)
            .concatenating(CGAffineTransform(translationX: rect.minX, y: rect.minY)))
    }
}

