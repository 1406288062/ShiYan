import SwiftUI

struct AgentSidebar: View {
    @ObservedObject var store: AgentStore
    @ObservedObject private var account = ShiyanAccount.shared
    private let dotsStore = DotsStore.shared
    @Environment(\.scenePhase) private var scenePhase
    let topInset: CGFloat
    let bottomInset: CGFloat
    let isOpen: Bool
     
    let revealProgress: CGFloat
    let onFeature: (ShiyanFeaturePage) -> Void
    let onSelect: (UUID) -> Void
    @State private var searching = false
    @State private var projectDialog = false
    @State private var projectTarget: UUID?
    @State private var projectName = ""
    @State private var expandedProjects = Set<UUID>()
    @State private var renameTarget: UUID?
    @State private var renameText = ""
    @State private var deleteTarget: UUID?
    @State private var menuTarget: UUID?
    @State private var menuHeight: CGFloat = 170
    @State private var rowFrames: [UUID: CGRect] = [:]
    @State private var footerTop: CGFloat = 100000
    @State private var deleteHeight: CGFloat = 172
    @Environment(\.colorScheme) private var scheme
    private var contentOpacity: Double {
        let t = Double(min(max(revealProgress, 0), 1))
        return t * t * (3 - 2 * t)
    }
    private var contentScale: CGFloat { 0.945 + 0.055 * min(max(revealProgress, 0), 1) }
     
     
     
    private var contentShiftX: CGFloat { 6 * (1 - min(max(revealProgress, 0), 1)) }

    var body: some View {
        GeometryReader { geometry in
            ZStack(alignment: .top) {
                 
                (scheme == .dark ? Color(white: 0.065) : Color(white: 0.985))
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 6) {
                        let pinned = store.list(query: "", pinned: true)
                        let recent = store.list(query: "", pinned: false)
                            .filter { $0.projectID == nil }
                        if account.canUseAI {
                            featureRow(.dots)
                            featureRow(.scheduled)
                        }
                        featureRow(.enhance)
                        featureRow(.space)
                        featureRow(.knowledge)
                        Color.clear.frame(height: 16).accessibilityHidden(true)
                        if !pinned.isEmpty {
                            sectionTitle("置顶")
                            ForEach(pinned) { session in row(session) }
                        }
                        HStack {
                            sectionTitle("项目", faded: false)
                            Spacer()
                            Button { projectTarget = nil; projectName = ""; projectDialog = true } label: { Image(systemName: "plus").frame(width: 36, height: 36) }
                                .buttonStyle(.plain).foregroundStyle(.secondary).padding(.trailing, 22)
                                .accessibilityLabel("新建项目").accessibilityIdentifier("create-sync-project")
                        }.padding(.top, pinned.isEmpty ? 0 : 20)
                            .agentEdgeFade(space: "sidebarViewport", topGone: topInset * 0.45, topClear: topInset + 78,
                                           bottomClear: footerTop - 24, bottomGone: footerTop + 28, blurWholeRow: true)
                        ForEach(store.projects) { project in projectRow(project) }
                        sectionTitle("最近").padding(.top, 24)
                        ForEach(recent) { session in row(session) }
                    }
                    .padding(.top, topInset + 76)
                    .padding(.bottom, bottomInset + ShiyanPreviewLayout.controlDiameter + 48)
                }
                .opacity(contentOpacity)
                .offset(x: contentShiftX)
                .scrollIndicators(.hidden).scrollEdgeEffectHidden(true)
                .scrollDisabled(deleteTarget != nil || menuTarget != nil)
                .accessibilityIdentifier("agent-sidebar-scroll")
                HStack {
                    Image("logo")
                        .resizable().scaledToFill()
                        .frame(width: 30, height: 30)
                        .clipShape(Circle())
                        .scaleEffect(contentScale, anchor: .leading)
                        .accessibilityIdentifier("sidebar-brand-logo")
                    Text("拾燕").font(.system(size: 28, weight: .semibold)).foregroundStyle(.primary)
                        .scaleEffect(contentScale, anchor: .leading)
                    Spacer(minLength: 6)
                    AgentRoundButton(symbol: "magnifyingglass", label: "搜索会话",
                                     diameter: ShiyanPreviewLayout.controlDiameter) {
                        searching = true
                    }
                    .scaleEffect(contentScale, anchor: .center)
                }.padding(.leading, 28).padding(.trailing, 22).padding(.top, topInset + 3)
                .opacity(contentOpacity)
                .offset(x: contentShiftX)

                VStack(spacing: 0) {
                    Spacer(minLength: 0)
                    sidebarFooter
                }
                .opacity(contentOpacity)
                .offset(x: contentShiftX)

                if let target = menuTarget {
                    let frame = rowFrames[target] ?? CGRect(x: 14, y: geometry.size.height / 2,
                                                           width: geometry.size.width - 28, height: 48)
                    let placeBelow = frame.maxY + menuHeight + 20 < geometry.size.height - 20
                    let midpoint = placeBelow
                        ? frame.maxY + menuHeight / 2 + 8
                        : frame.minY - menuHeight / 2 - 8
                    Button { menuTarget = nil } label: { Color.clear.contentShape(Rectangle()) }
                        .buttonStyle(.plain)
                        .accessibilityLabel("关闭会话菜单")
                    conversationMenu(target)
                        .frame(width: min(258, geometry.size.width - 24))
                        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { menuHeight = $0 }
                        .position(x: geometry.size.width / 2,
                                  y: min(max(midpoint, topInset + menuHeight / 2 + 12),
                                         geometry.size.height - menuHeight / 2 - 12))
                        .transition(.opacity.combined(with: .scale(scale: 0.97)))
                        .accessibilitySortPriority(10)
                }

                if let target = deleteTarget {
                    let row = rowFrames[target] ?? CGRect(x: 14, y: geometry.size.height / 2, width: geometry.size.width - 28, height: 48)
                    let above = row.minY >= topInset * 0.45 + deleteHeight + 12
                    let desiredY = above ? row.minY - deleteHeight / 2 - 8 : row.maxY + deleteHeight / 2 + 8
                     
                    Button { deleteTarget = nil } label: { Color.clear.contentShape(Rectangle()) }
                        .buttonStyle(.plain)
                        .accessibilityLabel("取消删除")
                        .accessibilityIdentifier("cancel-delete-conversation")
                    deleteConfirmation(target, pointsDown: above)
                        .frame(width: min(280, geometry.size.width - 24))
                        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { deleteHeight = $0 }
                        .position(x: geometry.size.width / 2,
                                  y: min(max(desiredY, topInset * 0.45 + deleteHeight / 2 + 8),
                                         geometry.size.height - deleteHeight / 2 - 20))
                        .transition(.opacity.combined(with: .scale(scale: 0.97)))
                        .accessibilitySortPriority(10)
                }
            }
            .coordinateSpace(name: "sidebarViewport")
             
            .clipped()
             
             
        }
        // Keep the background sidebar anchored while an editing cover shows its keyboard.
        .ignoresSafeArea(.keyboard, edges: .bottom)
        .fullScreenCover(isPresented: $searching) {
            AgentConversationSearch(store: store) { id in searching = false; onSelect(id) }
        }
         
         
        .fullScreenCover(isPresented: Binding(
            get: { renameTarget != nil },
            set: { if !$0 { renameTarget = nil } }
        )) {
            AgentRenameDialog(
                title: $renameText,
                cancel: { renameTarget = nil },
                save: {
                    if let id = renameTarget { store.rename(id, title: renameText) }
                    renameTarget = nil
                }
            )
        }
        .fullScreenCover(isPresented: $projectDialog) {
            AgentRenameDialog(title: $projectName, cancel: { projectDialog = false }, save: {
                if let id = projectTarget { store.renameProject(id, name: projectName) }
                else { _ = store.createProject(name: projectName) }
                projectDialog = false
            }, heading: projectTarget == nil ? "新建项目" : "重命名项目", fieldPlaceholder: "项目名称")
        }
        // These transparent editing covers fade their own content; skip the system page transition.
        .transaction(value: projectDialog) { $0.disablesAnimations = true }
        .transaction(value: renameTarget) { $0.disablesAnimations = true }
        .task {
            if scenePhase == .active { dotsStore.startMonitoring() }
            if account.canUseAI { await dotsStore.refreshIdentity() }
        }
        .onDisappear { dotsStore.stopMonitoring() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active {
                dotsStore.startMonitoring()
                Task { if account.canUseAI { await dotsStore.refreshIdentity() } }
            } else { dotsStore.stopMonitoring() }
        }
        .onChange(of: isOpen) { _, open in
            if !open { deleteTarget = nil; menuTarget = nil }
            else { Task { if account.canUseAI { await dotsStore.refreshIdentity() } } }
        }
        .animation(.easeInOut(duration: 0.2), value: deleteTarget)
        .animation(.easeInOut(duration: 0.18), value: menuTarget)
    }

    private var sidebarFooter: some View {
        HStack(spacing: 16) {
            Button { let id = store.newConversation(); onSelect(id) } label: {
                Label("新聊天", systemImage: "square.and.pencil")
                    .font(.system(size: 18, weight: .semibold))
                    .padding(.horizontal, 22)
                    .frame(height: ShiyanPreviewLayout.controlDiameter)
                    .foregroundStyle(.primary)
                    .shiyanGlass(in: Capsule(), tint: .white.opacity(0.04), interactive: true)
                    .contentShape(Capsule())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("sidebar-new-chat")
            Spacer(minLength: 0)
            AgentRoundButton(symbol: "gearshape", label: "设置",
                             diameter: ShiyanPreviewLayout.controlDiameter) {
                onFeature(.settings)
            }
            .accessibilityIdentifier("sidebar-feature-settings")
        }
        .padding(.leading, 28).padding(.trailing, 22)
        .padding(.top, 20).padding(.bottom, bottomInset + 12)
        .onGeometryChange(for: CGFloat.self) { $0.frame(in: .named("sidebarViewport")).minY } action: { value in
            if abs(value - footerTop) > 0.25 { footerTop = value }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("sidebar-footer")
    }

    private func featureRow(_ page: ShiyanFeaturePage) -> some View {
        Group {
            if page == .dots {
                DotsSidebarButton { onFeature(page) }
            } else {
                Button { onFeature(page) } label: {
                    HStack(spacing: 14) {
                        page.icon.padding(page == .scheduled ? 2 : 0)
                            .font(.system(size: 20, weight: .regular)).frame(width: 22, height: 22)
                        Text(page.title).font(.system(size: 18)).lineLimit(1)
                        Spacer()
                    }
                    .frame(height: 48).padding(.horizontal, 28).contentShape(Rectangle())
                }.accessibilityLabel(page.title)
            }
        }
        .buttonStyle(.plain)
        .foregroundStyle(.primary)
        .accessibilityIdentifier("sidebar-feature-\(page.rawValue)")
        .agentEdgeFade(space: "sidebarViewport", topGone: topInset * 0.45, topClear: topInset + 78,
                       bottomClear: footerTop - 24, bottomGone: footerTop + 28, blurWholeRow: true)
    }

    private func projectRow(_ project: AgentProject) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 14) {
                Button {
                    if expandedProjects.contains(project.id) { expandedProjects.remove(project.id) }
                    else { expandedProjects.insert(project.id) }
                } label: {
                    HStack(spacing: 14) { Image(systemName: expandedProjects.contains(project.id) ? "folder.fill" : "folder"); Text(project.name).lineLimit(1); Spacer() }
                        .font(.system(size: 18)).frame(minHeight: 48).contentShape(Rectangle())
                }.buttonStyle(.plain)
                Menu {
                    Button("新聊天", systemImage: "square.and.pencil") {
                        let id = store.newConversation(); store.setProject(project.id, conversation: id); onSelect(id)
                    }
                    Button { projectTarget = project.id; projectName = project.name; projectDialog = true } label: {
                        Label { Text("重命名") } icon: { Image(uiImage: AgentMenuIcons.rename).resizable().frame(width: 20, height: 20) }
                    }
                } label: { ShiyanMoreButtonLabel(hasGlass: false) }
                .buttonStyle(.plain)
            }.padding(.horizontal, 28).foregroundStyle(.primary)
                .agentEdgeFade(space: "sidebarViewport", topGone: topInset * 0.45, topClear: topInset + 78,
                       bottomClear: footerTop - 24, bottomGone: footerTop + 28, blurWholeRow: true)
            if expandedProjects.contains(project.id) {
                ForEach(store.conversations.filter { $0.hasSentMessage && $0.projectID == project.id }.sorted { $0.updatedAt > $1.updatedAt }) { conversation in row(conversation) }
            }
        }.accessibilityIdentifier("sync-project-\(project.id.uuidString)")
    }

    private func conversationMenu(_ id: UUID) -> some View {
        let pinned = store.conversation(id)?.isPinned ?? false
        return VStack(spacing: 4) {
            Button {
                menuTarget = nil
                store.togglePin(id)
            } label: {
                Label { Text(pinned ? "取消置顶" : "置顶") } icon: {
                    Image(uiImage: pinned ? AgentMenuIcons.unpin : AgentMenuIcons.pin).resizable().frame(width: 20, height: 20)
                }
                    .frame(maxWidth: .infinity, minHeight: 47, alignment: .leading)
                    .contentShape(Rectangle())
            }
            .accessibilityIdentifier(pinned ? "session-unpin" : "session-pin")
            Button {
                menuTarget = nil
                renameText = store.conversation(id)?.title ?? ""
                renameTarget = id
            } label: {
                Label { Text("重命名") } icon: {
                    Image(uiImage: AgentMenuIcons.rename).resizable().frame(width: 20, height: 20)
                }
                    .frame(maxWidth: .infinity, minHeight: 47, alignment: .leading)
                    .contentShape(Rectangle())
            }
            conversationProjectMenu(id)
            Button {
                menuTarget = nil
                deleteTarget = id
            } label: {
                Label("删除", systemImage: "trash")
                    .foregroundStyle(.red)
                    .frame(maxWidth: .infinity, minHeight: 47, alignment: .leading)
                    .contentShape(Rectangle())
            }
            .accessibilityIdentifier("session-delete-action")
        }
        .font(.system(size: 16, weight: .medium))
        .buttonStyle(.plain)
        .padding(.leading, 23)
        .padding(.trailing, 11)
        .padding(.vertical, 7)
        .shiyanGlass(in: RoundedRectangle(cornerRadius: 20, style: .continuous),
                     tint: .white.opacity(0.07), interactive: false)
        .shadow(color: .black.opacity(0.08), radius: 12, y: 5)
         
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("conversation-actions-menu")
    }

    private func conversationProjectMenu(_ id: UUID) -> some View {
        let projectID = store.conversation(id)?.projectID
        let availableProjects = store.projects.filter { $0.id != projectID }
        let currentProject = store.projects.first { $0.id == projectID }
        let removalLabel = currentProject.map { "从“\($0.name)”中移除" } ?? "从原项目中移除"
        return Menu {
            ForEach(availableProjects) { project in
                Button {
                    store.setProject(project.id, conversation: id)
                    expandedProjects.insert(project.id)
                    menuTarget = nil
                } label: {
                    Label { Text(project.name) } icon: {
                        Image(uiImage: AgentMenuIcons.folder).resizable().frame(width: 20, height: 20)
                    }
                }
                .accessibilityIdentifier("session-move-project-\(project.id.uuidString)")
            }
            if projectID != nil {
                Button {
                    store.setProject(nil, conversation: id)
                    menuTarget = nil
                } label: {
                    Label { Text(removalLabel) } icon: {
                        Image(uiImage: AgentMenuIcons.folderRemove).resizable().frame(width: 20, height: 20)
                    }
                }
                .accessibilityIdentifier("session-remove-project")
            } else if availableProjects.isEmpty {
                Button("暂无可选项目") {}
                    .disabled(true)
            }
        } label: {
            Label { Text("项目") } icon: {
                Image(uiImage: AgentMenuIcons.project).resizable().frame(width: 20, height: 20)
            }
            .frame(maxWidth: .infinity, minHeight: 47, alignment: .leading)
        }
         
        .menuOrder(.fixed)
        .accessibilityIdentifier("session-project-menu")
    }

    private func deleteConfirmation(_ id: UUID, pointsDown: Bool) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("删除对话？").font(.headline).accessibilityIdentifier("delete-conversation-title")
            Text("这段对话将被删除，已保存的图片会保留。")
                .font(.subheadline).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            Button(role: .destructive) {
                deleteTarget = nil
                Task { await store.delete(id) }
            } label: {
                Text("删除").font(.body.weight(.semibold)).foregroundStyle(.red)
                    .frame(maxWidth: .infinity, minHeight: 46)
                    .background(Color.primary.opacity(0.055), in: Capsule())
            }.buttonStyle(.plain).padding(.top, 4)
                .accessibilityIdentifier("confirm-delete-conversation")
        }
        .padding(.horizontal, 16)
        .padding(.top, pointsDown ? 18 : 30)
        .padding(.bottom, pointsDown ? 28 : 16)
        .shiyanGlass(in: AgentCalloutShape(pointsDown: pointsDown), tint: .white.opacity(0.07))
        .shadow(color: .black.opacity(0.08), radius: 12, y: 4)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("delete-conversation-popover")
    }
    @ViewBuilder
    private func sectionTitle(_ text: String, faded: Bool = true) -> some View {
        let title = Text(text).font(.system(size: 17, weight: .semibold))
            .scaleEffect(contentScale, anchor: .leading)
            .padding(.leading, 28).padding(.bottom, 12)
        if faded {
            title.agentEdgeFade(space: "sidebarViewport", topGone: topInset * 0.45, topClear: topInset + 78,
                                bottomClear: footerTop - 24, bottomGone: footerTop + 28)
        } else {
            title
        }
    }
    private func row(_ conversation: AgentConversation) -> some View {
        let selected = store.selectedID == conversation.id
        return Button {
             
             
            guard menuTarget == nil else { return }
            onSelect(conversation.id)
        } label: {
            HStack(spacing: 14) {
                if conversation.isPinned {
                    AgentConversationBubble().stroke(.primary, style: StrokeStyle(lineWidth: 1.8, lineCap: .round, lineJoin: .round))
                        .frame(width: 24, height: 24).frame(height: 28)
                        .scaleEffect(contentScale, anchor: .center)
                }
                Text(conversation.title).font(.system(size: 18)).lineLimit(1).truncationMode(.tail)
                    .scaleEffect(contentScale, anchor: .leading)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if conversation.hasUnread { Circle().fill(Color.blue).frame(width: 8, height: 8).scaleEffect(contentScale).accessibilityLabel("有新内容") }
                else if conversation.isBusy { ProgressView().controlSize(.mini).tint(.secondary).scaleEffect(contentScale) }
            }
            .foregroundStyle(.primary).padding(.horizontal, 14).frame(minHeight: 48)
            .contentShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
        .buttonStyle(AgentSessionButtonStyle(selected: selected, menuOpen: menuTarget == conversation.id))
        .padding(.horizontal, 14)
         
        .accessibilityLabel(conversation.title)
        .accessibilityValue([selected ? "当前会话" : "", conversation.isPinned ? "已置顶" : ""].filter { !$0.isEmpty }.joined(separator: "，"))
        .accessibilityIdentifier("session-row-\(conversation.id.uuidString)")
        .onGeometryChange(for: CGRect.self) { $0.frame(in: .named("sidebarViewport")) } action: { rowFrames[conversation.id] = $0 }
        .highPriorityGesture(
            LongPressGesture(minimumDuration: 0.48, maximumDistance: 20)
                .onEnded { _ in
                    NSLog("[ShiyanSidebarMenu] opened=%@", conversation.id.uuidString)
                    UIImpactFeedbackGenerator(style: .light).impactOccurred()
                    withAnimation(.easeOut(duration: 0.18)) { menuTarget = conversation.id }
                }
        )
         
        .agentEdgeFade(space: "sidebarViewport", topGone: topInset * 0.45, topClear: topInset + 78,
                       bottomClear: footerTop - 24, bottomGone: footerTop + 28, blurWholeRow: true)
        .id("\(conversation.id.uuidString)-\(conversation.isPinned)")
    }
}

private struct AgentSessionButtonStyle: ButtonStyle {
    let selected: Bool
    let menuOpen: Bool
    @Environment(\.colorScheme) private var scheme
    func makeBody(configuration: Configuration) -> some View {
         
         
        let lifted = configuration.isPressed || menuOpen
        return configuration.label
            .background(
                lifted ? (scheme == .dark ? Color(white: 0.19) : .white) :
                    (selected ? Color(white: scheme == .dark ? 0.13 : 0.933) : .clear),
                in: RoundedRectangle(cornerRadius: 14, style: .continuous)
            )
            .overlay {
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .strokeBorder(selected ? Color.white.opacity(scheme == .dark ? 0.07 : 0.72) :
                                    (lifted ? Color.primary.opacity(0.085) : .clear),
                                  lineWidth: 0.75)
            }
             
             
             
            .shadow(color: lifted ? Color.black.opacity(scheme == .dark ? 0.14 : 0.045) :
                        (selected ? Color.black.opacity(scheme == .dark ? 0 : 0.035) : .clear),
                    radius: lifted ? 3 : 5, y: lifted ? 2 : 1)
            .scaleEffect(lifted ? 0.99 : 1, anchor: .center)
            .animation(.spring(response: 0.28, dampingFraction: 0.75), value: lifted)
    }
}


 
 
private struct AgentRenameDialog: View {
    @Binding var title: String
    let cancel: () -> Void
    let save: () -> Void
    var heading = "重命名会话"
    var fieldPlaceholder = "会话名称"

    @FocusState private var nameFocused: Bool
    @State private var appeared = false

    var body: some View {
        GeometryReader { geometry in
            ZStack {
                Color.black.opacity(appeared ? 0.20 : 0)
                    .ignoresSafeArea()
                    .onTapGesture(perform: cancel)

                VStack(spacing: 15) {
                    Text(heading)
                        .font(.system(size: 19, weight: .semibold))
                        .frame(maxWidth: .infinity)

                    TextField(fieldPlaceholder, text: $title)
                        .font(.system(size: 17))
                        .padding(.horizontal, 14)
                        .frame(height: 48)
                        .frame(maxWidth: .infinity)
                        .background(Color(uiColor: .tertiarySystemFill),
                                    in: Capsule())
                        .focused($nameFocused)
                        .submitLabel(.done)
                        .onSubmit(save)
                        .accessibilityIdentifier("rename-conversation-field")

                    HStack(spacing: 10) {
                        Button(action: cancel) {
                            Text("取消")
                                .font(.system(size: 17, weight: .semibold))
                                .foregroundStyle(.primary)
                                .frame(maxWidth: .infinity, minHeight: 48)
                                .background(Color.primary.opacity(0.065), in: Capsule())
                        }
                        .accessibilityIdentifier("rename-conversation-cancel")
                        Button(action: save) {
                            Text("保存")
                                .font(.system(size: 17, weight: .semibold))
                                .foregroundStyle(.white)
                                .frame(maxWidth: .infinity, minHeight: 48)
                                .background(Color.accentColor, in: Capsule())
                        }
                        .accessibilityIdentifier("rename-conversation-save")
                    }
                    .buttonStyle(.plain)
                    .frame(maxWidth: .infinity)
                }
                .padding(18)
                .frame(width: min(320, geometry.size.width - 42))
                .shiyanGlass(in: RoundedRectangle(cornerRadius: 26, style: .continuous),
                             tint: .white.opacity(0.05), interactive: false)
                .shadow(color: .black.opacity(0.13), radius: 20, y: 8)
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("rename-conversation-dialog")
                .opacity(appeared ? 1 : 0)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .presentationBackground(.clear)
        .task {
            withAnimation(.easeOut(duration: 0.16)) { appeared = true }
            try? await Task.sleep(for: .milliseconds(180))
            nameFocused = true
        }
    }
}


 
private struct DotsSidebarButton: View {
    @ObservedObject private var store = DotsStore.shared
    let onSelect: () -> Void
    var body: some View {
        Button(action: onSelect) {
            HStack(spacing: 14) {
                DotsIdentityIcon().frame(width: 26, height: 26)
                Text(store.displayName).font(.system(size: 18)).lineLimit(1)
                Spacer(minLength: 8)
                if store.unreadCount > 0 {
                    Text(String(store.unreadCount))
                        .font(.system(size: 12, weight: .semibold)).monospacedDigit()
                        .foregroundStyle(.white).padding(.horizontal, 7).padding(.vertical, 3)
                        .background(Color.accentColor, in: Capsule())
                        .accessibilityIdentifier("sidebar-dots-unread-count")
                }
            }
            .frame(height: 48).padding(.horizontal, 28).contentShape(Rectangle())
        }
        .accessibilityLabel(store.displayName + (store.unreadCount > 0 ? "，\(store.unreadCount) 条未读回复" : ""))
    }
}
