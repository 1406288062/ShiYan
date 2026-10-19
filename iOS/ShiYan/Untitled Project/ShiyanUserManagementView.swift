import SwiftUI

private struct ShiyanUserList: Decodable { let users: [ShiyanUser] }

struct ShiyanUserManagementView: View {
    let topInset: CGFloat
    let bottomInset: CGFloat
    let hasUnread: Bool
    let onSidebar: () -> Void
    let onBack: () -> Void
    @ObservedObject private var account = ShiyanAccount.shared
    @State private var users: [ShiyanUser] = []
    @State private var loading = false
    @State private var error: String?
    @State private var editingID: String?
    private var background: Color { Color(uiColor: .systemBackground) }

    var body: some View {
        ZStack(alignment: .top) {
            background.ignoresSafeArea()
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    Text("管理账户角色、启用状态和服务器访问权限。")
                        .font(.system(size: 12)).foregroundStyle(.secondary).padding(.bottom, 16)
                    if let error { Text(error).foregroundStyle(.red).font(.subheadline).padding(.bottom, 12) }
                    if loading && users.isEmpty { ProgressView().frame(maxWidth: .infinity) }
                    ForEach(users) { user in
                        VStack(alignment: .leading, spacing: 0) {
                            Button { editingID = editingID == user.id ? nil : user.id } label: {
                                HStack(spacing: 12) {
                                    VStack(alignment: .leading, spacing: 4) {
                                        Text(user.name).font(.system(size: 16, weight: .medium)).foregroundStyle(.primary)
                                        if let email = user.email, email != user.name {
                                            Text(email).font(.system(size: 12)).foregroundStyle(.secondary)
                                        }
                                        Text(user.status == "disabled" ? "已停用" : user.isAdmin ? "管理员" : "普通用户")
                                            .font(.system(size: 12)).foregroundStyle(.secondary)
                                    }
                                    Spacer(minLength: 8)
                                    if user.owner == "shiyan-private-owner" {
                                        Text("所有者").font(.system(size: 12)).foregroundStyle(.secondary)
                                    }
                                    Image(systemName: editingID == user.id ? "chevron.up" : "chevron.down")
                                        .font(.system(size: 11, weight: .medium)).foregroundStyle(.secondary)
                                }
                                .padding(.vertical, 16).frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
                            }.buttonStyle(.plain)
                            if editingID == user.id {
                                ShiyanUserEditor(user: user) { await refresh() }.id(user.id + ":" + String(user.revision ?? 0))
                                    .padding(.bottom, 16)
                            }
                            Divider()
                        }
                    }
                    if !loading && users.isEmpty && error == nil {
                        Text("暂无用户").font(.subheadline).foregroundStyle(.secondary).frame(maxWidth: .infinity)
                    }
                }
                .frame(maxWidth: 640, alignment: .leading)
                .padding(.horizontal, 24).padding(.top, topInset + 82).padding(.bottom, bottomInset + 24)
                .frame(maxWidth: .infinity)
            }
            .refreshable { await refresh() }
            ShiyanFeatureHeader(page: .settings, topInset: topInset, hasUnread: hasUnread,
                onSidebar: onSidebar, onBack: onBack) {
                    AgentRoundButton(symbol: "arrow.clockwise", label: "刷新用户", diameter: ShiyanPreviewLayout.controlDiameter) {
                        Task { await refresh() }
                    }.disabled(loading)
                }
                .overlay(alignment: .top) {
                    Text("用户权限管理").font(.system(size: 17, weight: .semibold))
                        .frame(height: ShiyanPreviewLayout.controlDiameter).padding(.top, topInset + 3).allowsHitTesting(false)
                }.background(background)
        }
        .task { await refresh() }
        .accessibilityIdentifier("settings-user-management")
    }
    private func refresh() async {
        guard account.user?.isAdmin == true, !loading else { return }
        loading = true; defer { loading = false }
        do {
            let data = try await CodexClient.shared.authRequest(route: "admin/users", method: "GET")
            users = try JSONDecoder().decode(ShiyanUserList.self, from: data).users
            error = nil
        } catch { self.error = error.localizedDescription }
    }
}

private struct ShiyanUserEditor: View {
    let user: ShiyanUser
    let onSaved: () async -> Void
    @State private var role: String
    @State private var active: Bool
    @State private var serverAccess: Bool
    @State private var saving = false
    @State private var error: String?
    private var protectedOwner: Bool { user.owner == "shiyan-private-owner" }
    private var changed: Bool { role != user.role || active != (user.status == "active") || serverAccess != user.serverAccess }
    init(user: ShiyanUser, onSaved: @escaping () async -> Void) {
        self.user = user; self.onSaved = onSaved
        _role = State(initialValue: user.role)
        _active = State(initialValue: user.status == "active")
        _serverAccess = State(initialValue: user.serverAccess)
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("角色").foregroundStyle(.secondary)
                Spacer()
                Picker("角色", selection: $role) {
                    Text("普通用户").tag("user")
                    Text("管理员").tag("admin")
                }.labelsHidden().pickerStyle(.menu).disabled(protectedOwner)
            }
            Toggle("账户已启用", isOn: $active).disabled(protectedOwner)
            Toggle("服务器访问", isOn: $serverAccess).disabled(protectedOwner || role != "admin" || !ShiyanAccount.shared.canAccessServer)
            Text(protectedOwner ? "所有者账户保留管理员和服务器访问权限。" : "普通用户仅能访问自己的内容；停用后会退出登录。")
                .font(.system(size: 12)).foregroundStyle(.secondary)
            if let error { Text(error).foregroundStyle(.red).font(.system(size: 12)) }
            if !protectedOwner {
                HStack {
                    Spacer()
                    Button(saving ? "保存中…" : "保存") { Task { await save() } }
                        .disabled(saving || !changed)
                }
            }
        }
        .font(.system(size: 14)).disabled(saving)
        .onChange(of: role) { _, value in if value != "admin" { serverAccess = false } }
    }
    private func save() async {
        guard !saving, changed, !protectedOwner else { return }
        saving = true; defer { saving = false }
        do {
            var object: [String: Any] = ["role": role, "status": active ? "active" : "disabled", "serverAccess": role == "admin" && serverAccess]
            if let revision = user.revision { object["revision"] = revision }
            let id = user.id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? user.id
            _ = try await CodexClient.shared.authRequest(route: "admin/users/" + id, method: "PATCH", object: object)
            await ShiyanAccount.shared.validate()
            await onSaved()
        } catch { self.error = error.localizedDescription }
    }
}
