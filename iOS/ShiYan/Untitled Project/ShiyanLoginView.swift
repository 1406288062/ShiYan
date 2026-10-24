import SwiftUI

private enum ShiyanAuthPalette {
    static let cyan = Color(red: 78/255, green: 175/255, blue: 234/255)
    static let indigo = Color(red: 94/255, green: 96/255, blue: 237/255)
    static let violet = Color(red: 171/255, green: 99/255, blue: 223/255)
    static let coral = Color(red: 243/255, green: 129/255, blue: 134/255)
    static let aqua = Color(red: 88/255, green: 190/255, blue: 220/255)
    static let gradient = LinearGradient(colors: [cyan, indigo, violet], startPoint: .leading, endPoint: .trailing)
}

struct ShiyanLoginView: View {
    @ObservedObject private var account = ShiyanAccount.shared
    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceMotion) private var reducedMotion
    @State private var registering = false
    @State private var resettingPassword = false
    @State private var passwordResetComplete = false
    @State private var email = ""
    @State private var password = ""
    @State private var confirmedPassword = ""
    @State private var showsPassword = false
    @State private var showsConfirmation = false
    @State private var confirmationChecked = false
    @State private var displayName = ""
    @State private var verificationCode = ""
    @State private var codeResendAt = Date.distantPast
    @State private var codeSeconds = 0
    @State private var codeSent = false
    @FocusState private var focused: Field?
    private enum Field { case name, email, password, confirmation, code }
    private var bootstrap: Bool { account.status?.bootstrapRequired == true && account.status?.canBootstrap == true }
    private var creating: Bool { !resettingPassword && (registering || bootstrap) }
    private var verifyingEmail: Bool { creating || resettingPassword }
    private var passwordMismatch: Bool { verifyingEmail && confirmationChecked && !confirmedPassword.isEmpty && confirmedPassword != password }
    private var valid: Bool { email.contains("@") && !email.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && password.count >= 8 && (!creating || !displayName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) && (!verifyingEmail || (verificationCode.count == 6 && confirmedPassword == password)) }

    var body: some View {
        GeometryReader { geometry in
            ZStack {
                (scheme == .dark ? Color(red: 0.045, green: 0.055, blue: 0.09) : Color(red: 0.95, green: 0.97, blue: 1)).ignoresSafeArea()
                TimelineView(.animation(minimumInterval: 1/24, paused: reducedMotion)) { context in
                    let phase = reducedMotion ? 0 : context.date.timeIntervalSinceReferenceDate / 12
                    ZStack {
                        ellipse(ShiyanAuthPalette.cyan, x: geometry.size.width * (0.18 + 0.12 * sin(phase)), y: geometry.size.height * 0.25)
                        ellipse(ShiyanAuthPalette.violet, x: geometry.size.width * 0.85, y: geometry.size.height * (0.7 + 0.08 * cos(phase)))
                        ellipse(ShiyanAuthPalette.coral.opacity(scheme == .dark ? 0.42 : 0.7), x: geometry.size.width * 0.15, y: geometry.size.height * 0.9)
                        ellipse(ShiyanAuthPalette.aqua.opacity(scheme == .dark ? 0.42 : 0.7), x: geometry.size.width * 0.9, y: geometry.size.height * 0.1)
                    }
                    .blur(radius: 85)
                    .opacity(scheme == .dark ? 0.4 : 0.3)
                }
                .ignoresSafeArea().allowsHitTesting(false).accessibilityHidden(true)
                ScrollView {
                    VStack(spacing: 20) {
                        HStack(spacing: 11) {
                            Image("logo").resizable().scaledToFit()
                                .frame(width: 44, height: 44).offset(y: -0.92)
                                .accessibilityHidden(true)
                            Image("AuthWordmark").renderingMode(.template).resizable().scaledToFit()
                                .frame(width: 65.973, height: 34).foregroundStyle(LinearGradient(colors: [Color(red: 241/255, green: 193/255, blue: 125/255), Color(red: 236/255, green: 157/255, blue: 184/255), Color(red: 222/255, green: 146/255, blue: 126/255)], startPoint: .topLeading, endPoint: .bottomTrailing))
                                .accessibilityHidden(true)
                        }
                        .accessibilityElement(children: .ignore).accessibilityLabel("拾燕")
                        .frame(maxWidth: .infinity, alignment: .center)
                        VStack(alignment: .leading, spacing: 0) {
                            if bootstrap {
                                Text("绑定你的管理员账户，保留现有内容。")
                                    .font(.subheadline).foregroundStyle(.secondary).padding(.bottom, 16)
                            }
                            VStack(spacing: 16) {
                                if creating {
                                    labeledField("用户名") {
                                        TextField("用户名", text: $displayName).textContentType(.nickname)
                                            .focused($focused, equals: .name).submitLabel(.next).onSubmit { focused = .email }
                                            .onChange(of: displayName) { _, value in displayName = String(value.prefix(80)) }
                                            .modifier(AuthField())
                                    }
                                }
                                labeledField("邮箱") {
                                    TextField("邮箱地址", text: $email).keyboardType(.emailAddress)
                                        .textInputAutocapitalization(.never).autocorrectionDisabled().textContentType(.username)
                                        .focused($focused, equals: .email).submitLabel(.next).onSubmit { focused = .password }
                                        .modifier(AuthField()).accessibilityIdentifier("auth-email")
                                }
                                labeledField("密码") {
                                    passwordInput(resettingPassword ? "新密码（至少 8 位）" : creating ? "密码（至少 8 位）" : "密码", text: $password, visible: showsPassword)
                                        .textContentType(verifyingEmail ? .newPassword : .password)
                                        .focused($focused, equals: .password).submitLabel(verifyingEmail ? .next : .go).onSubmit { if verifyingEmail { focused = .confirmation } else { submit() } }
                                        .modifier(AuthField())
                                        .overlay(alignment: .trailing) { passwordEye($showsPassword, field: .password) }
                                        .accessibilityIdentifier("auth-password")
                                }
                                if verifyingEmail {
                                    labeledField("密码确认") {
                                        passwordInput("密码确认", text: $confirmedPassword, visible: showsConfirmation)
                                            .textContentType(.newPassword)
                                            .focused($focused, equals: .confirmation).submitLabel(.next).onSubmit { focused = .code }
                                            .modifier(AuthField())
                                        .overlay(alignment: .trailing) { passwordEye($showsConfirmation, field: .confirmation) }
                                        .accessibilityIdentifier("auth-confirm-password")
                                    }
                                    if passwordMismatch {
                                        Text("两次输入的密码不一致").font(.footnote).foregroundStyle(.red)
                                            .frame(maxWidth: .infinity, alignment: .leading)
                                    }
                                    HStack(spacing: 0) {
                                        labeledField("邮箱验证码") {
                                            TextField("六位验证码", text: $verificationCode)
                                                .keyboardType(.numberPad).textContentType(.oneTimeCode)
                                                .focused($focused, equals: .code)
                                                .font(.system(size: 15)).padding(.leading, 18).frame(height: 48)
                                                .onChange(of: verificationCode) { _, value in
                                                    verificationCode = String(value.filter { $0.isASCII && $0.isNumber }.prefix(6))
                                                }
                                                .accessibilityIdentifier("auth-verification-code")
                                        }
                                        Button(codeSeconds > 0 ? "\(codeSeconds) 秒后重发" : "获取验证码") {
                                            guard checkConfirmationForAction() else { return }
                                            Task {
                                                if let seconds = await (resettingPassword ? account.requestPasswordResetCode(email: email) : account.requestRegistrationCode(email: email)) {
                                                    codeResendAt = Date().addingTimeInterval(TimeInterval(seconds))
                                                    codeSeconds = seconds; codeSent = true; focused = .code
                                                }
                                            }
                                        }
                                        .font(.system(size: 13, weight: .medium)).frame(width: 116, height: 48)
                                        .overlay(alignment: .leading) { Rectangle().fill(Color.primary.opacity(0.1)).frame(width: 1, height: 22) }
                                        .disabled(account.busy || account.checking || passwordMismatch || codeSeconds > 0 || !email.contains("@"))
                                        .saturation(passwordMismatch ? 0 : 1).opacity(passwordMismatch ? 0.45 : 1)
                                        .accessibilityIdentifier("auth-send-code")
                                    }
                                    .background(Color.primary.opacity(0.045), in: Capsule())
                                    .overlay { Capsule().stroke(Color.primary.opacity(0.1), lineWidth: 1) }
                                    if codeSent {
                                        Text(resettingPassword ? "如邮箱已注册，验证码将发送到邮箱，10 分钟内有效，请留意垃圾邮件。" : "验证码已发送，10 分钟内有效，请留意垃圾邮件。")
                                            .font(.caption).foregroundStyle(.secondary)
                                            .frame(maxWidth: .infinity, alignment: .leading)
                                    }
                                }
                                if passwordResetComplete {
                                    Text("密码已重置，请使用新密码登录。")
                                        .font(.subheadline).foregroundStyle(.secondary)
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                        .accessibilityIdentifier("auth-reset-success")
                                }
                                if let error = account.error {
                                    Text(error).font(.subheadline).foregroundStyle(.red)
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                        .accessibilityIdentifier("auth-error")
                                }
                                Button(action: submit) {
                                    HStack {
                                        Spacer()
                                        Text(account.checking ? "正在恢复登录…" : account.busy ? "处理中…" : resettingPassword ? "重置密码" : creating ? "创建账户" : "登录").font(.system(size: 15, weight: .semibold))
                                        Spacer()
                                        if account.busy || account.checking { ProgressView().tint(.white) }
                                    }
                                    .padding(.horizontal, 18).frame(height: 50).foregroundStyle(.white)
                                    .background(ShiyanAuthPalette.gradient, in: Capsule())
                                }
                                .buttonStyle(.plain).disabled(!valid || account.busy || account.checking).opacity(valid && !account.busy && !account.checking ? 1 : 0.55)
                                .saturation(passwordMismatch ? 0 : 1)
                                .accessibilityIdentifier("auth-submit")
                            }
                            if resettingPassword || !bootstrap {
                                HStack(spacing: 6) {
                                    if resettingPassword || registering || account.status?.registrationEnabled != false {
                                    Text(resettingPassword ? "记起密码了？" : registering ? "已有账户？" : "还没有账户？").foregroundStyle(.secondary)
                                    Button(resettingPassword || registering ? "返回登录" : "创建账户") {
                                        guard checkConfirmationForAction() else { return }
                                        if resettingPassword { resettingPassword = false; registering = false }
                                        else { registering.toggle() }
                                        clearAuthSecrets(); account.error = nil
                                    }
                                    .foregroundStyle(ShiyanAuthPalette.indigo).disabled(account.busy || account.checking || passwordMismatch)
                                    .saturation(passwordMismatch ? 0 : 1).opacity(passwordMismatch ? 0.45 : 1)
                                    }
                                    if !registering && !resettingPassword {
                                        Spacer(minLength: 12)
                                        Button("忘记密码？") {
                                            clearAuthSecrets(); resettingPassword = true; account.error = nil; focused = .email
                                        }
                                        .foregroundStyle(ShiyanAuthPalette.indigo)
                                        .disabled(account.busy || account.checking)
                                        .accessibilityIdentifier("auth-forgot-password")
                                    }
                                }
                                .font(.system(size: 14)).frame(maxWidth: .infinity)
                                .padding(.top, 21)
                            }
                        }
                        .padding(.horizontal, geometry.size.width < 480 ? 20 : 36)
                        .padding(.top, geometry.size.width < 480 ? 28 : 36).padding(.bottom, geometry.size.width < 480 ? 24 : 30)

                        if account.error != nil && !account.checking {
                            HStack(spacing: 10) {
                                Text("连接暂时中断").foregroundStyle(.secondary)
                                Button("重试") { Task { await account.validate(retryTransientFailure: true); if account.user == nil { await account.refreshStatus() } } }
                                    .disabled(passwordMismatch).saturation(passwordMismatch ? 0 : 1).opacity(passwordMismatch ? 0.45 : 1)
                                    .foregroundStyle(ShiyanAuthPalette.indigo)
                            }.font(.system(size: 13))
                        }
                    }
                    .frame(maxWidth: 428).padding(.horizontal, 24).padding(.vertical, 32)
                    .frame(maxWidth: .infinity, minHeight: geometry.size.height)
                }
                .scrollDismissesKeyboard(.interactively)
            }
        }
        .onChange(of: creating) { _, _ in clearAuthSecrets() }
        .onChange(of: resettingPassword) { _, resetting in
            let completed = passwordResetComplete
            clearAuthSecrets()
            if !resetting && completed { passwordResetComplete = true }
        }
        .onChange(of: focused) { previous, current in
            if previous == .confirmation && current != .confirmation { confirmationChecked = !confirmedPassword.isEmpty }
        }
        .onChange(of: confirmedPassword) { _, value in if value.isEmpty { confirmationChecked = false } }
        .onChange(of: email) { _, _ in verificationCode = ""; codeSent = false }
        .task(id: codeResendAt) {
            while codeResendAt > Date() && !Task.isCancelled {
                codeSeconds = max(0, Int(ceil(codeResendAt.timeIntervalSinceNow)))
                do { try await Task.sleep(for: .seconds(1)) } catch { return }
            }
            if !Task.isCancelled { codeSeconds = 0 }
        }
        .tint(ShiyanAuthPalette.indigo)
        .accessibilityIdentifier("account-authentication")
    }
    private func passwordInput(_ title: String, text: Binding<String>, visible: Bool) -> some View {
        Group {
            if visible { TextField(title, text: text) }
            else { SecureField(title, text: text) }
        }
        .padding(.trailing, 34)
    }
    private func passwordEye(_ visible: Binding<Bool>, field: Field) -> some View {
        Button {
            visible.wrappedValue.toggle()
            focused = field
        } label: {
            Image(systemName: visible.wrappedValue ? "eye.slash" : "eye")
                .font(.system(size: 18, weight: .regular)).foregroundStyle(.primary)
                .frame(width: 44, height: 48).contentShape(Rectangle())
        }
        .buttonStyle(.plain).padding(.trailing, 4)
        .disabled(account.busy || account.checking || passwordMismatch)
        .opacity(passwordMismatch ? 0.45 : 1)
        .accessibilityLabel((visible.wrappedValue ? "隐藏" : "显示") + (field == .password ? "密码" : "密码确认"))
    }
    private func labeledField<FieldContent: View>(_ title: String, @ViewBuilder content: () -> FieldContent) -> some View {
        content().frame(minWidth: 0, maxWidth: .infinity)
            .accessibilityLabel(title)
    }
    private func ellipse(_ color: Color, x: CGFloat, y: CGFloat) -> some View {
        Ellipse().fill(color).frame(width: 330, height: 380).position(x: x, y: y)
    }
    private func checkConfirmationForAction() -> Bool {
        if verifyingEmail && !confirmedPassword.isEmpty && (focused == .confirmation || confirmationChecked) {
            confirmationChecked = true
            focused = nil
            return confirmedPassword == password
        }
        return true
    }
    private func clearAuthSecrets() {
        password = ""; confirmedPassword = ""; verificationCode = ""; confirmationChecked = false
        showsPassword = false; showsConfirmation = false; codeSent = false
        codeResendAt = .distantPast; codeSeconds = 0; passwordResetComplete = false
    }
    private func submit() {
        guard valid, !account.busy, !account.checking else { return }
        focused = nil
        Task {
            if resettingPassword {
                if await account.resetPassword(email: email, password: password, confirmation: confirmedPassword, verificationCode: verificationCode) {
                    resettingPassword = false; registering = false
                    clearAuthSecrets(); passwordResetComplete = true
                }
                return
            }
            await account.authenticate(email: email, password: password, displayName: displayName.trimmingCharacters(in: .whitespacesAndNewlines), register: creating, bootstrap: bootstrap, verificationCode: verificationCode)
            if account.user != nil { password = ""; confirmedPassword = "" }
        }
    }
    private struct AuthField: ViewModifier {
        func body(content: Content) -> some View {
            content.font(.system(size: 15)).padding(.horizontal, 18).frame(height: 48)
                .background(Color.primary.opacity(0.045), in: Capsule())
                .overlay { Capsule().stroke(Color.primary.opacity(0.1), lineWidth: 1) }
        }
    }
}
