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
    @State private var email = ""
    @State private var password = ""
    @State private var displayName = ""
    @State private var verificationCode = ""
    @State private var codeResendAt = Date.distantPast
    @State private var codeSeconds = 0
    @State private var codeSent = false
    @FocusState private var focused: Field?
    private enum Field { case name, email, password, code }
    private var bootstrap: Bool { account.status?.bootstrapRequired == true && account.status?.canBootstrap == true }
    private var creating: Bool { registering || bootstrap }
    private var valid: Bool { email.contains("@") && !email.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && password.count >= 8 && (!creating || verificationCode.count == 6) }

    var body: some View {
        GeometryReader { geometry in
            ZStack {
                (scheme == .dark ? Color(red: 0.045, green: 0.055, blue: 0.09) : Color(red: 0.95, green: 0.97, blue: 1)).ignoresSafeArea()
                TimelineView(.animation(minimumInterval: 1/24, paused: reducedMotion)) { context in
                    let phase = reducedMotion ? 0 : context.date.timeIntervalSinceReferenceDate / 12
                    ZStack {
                        ellipse(ShiyanAuthPalette.cyan, x: geometry.size.width * (0.18 + 0.12 * sin(phase)), y: geometry.size.height * 0.25)
                        ellipse(ShiyanAuthPalette.violet, x: geometry.size.width * 0.85, y: geometry.size.height * (0.7 + 0.08 * cos(phase)))
                        ellipse(ShiyanAuthPalette.coral.opacity(0.7), x: geometry.size.width * 0.15, y: geometry.size.height * 0.9)
                        ellipse(ShiyanAuthPalette.aqua.opacity(0.7), x: geometry.size.width * 0.9, y: geometry.size.height * 0.1)
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
                                .frame(width: 65.973, height: 34).foregroundStyle(.primary)
                                .accessibilityHidden(true)
                        }
                        .accessibilityElement(children: .ignore).accessibilityLabel("拾燕")
                        .frame(maxWidth: .infinity, alignment: .center)
                        VStack(alignment: .leading, spacing: 0) {
                            Text(creating ? "创建账户" : "登录")
                                .font(.system(size: 27, weight: .semibold))
                            Capsule().fill(ShiyanAuthPalette.gradient).frame(width: 40, height: 3).padding(.top, 11).padding(.bottom, 27)
                            if bootstrap {
                                Text("绑定你的管理员账户，保留现有内容。")
                                    .font(.subheadline).foregroundStyle(.secondary).padding(.bottom, 16)
                            }
                            VStack(spacing: 12) {
                                if creating {
                                    TextField("显示名称（可选）", text: $displayName).textContentType(.name)
                                        .focused($focused, equals: .name).submitLabel(.next).onSubmit { focused = .email }
                                        .onChange(of: displayName) { _, value in displayName = String(value.prefix(80)) }
                                        .modifier(AuthField())
                                }
                                TextField("邮箱地址", text: $email).keyboardType(.emailAddress)
                                    .textInputAutocapitalization(.never).autocorrectionDisabled().textContentType(.username)
                                    .focused($focused, equals: .email).submitLabel(.next).onSubmit { focused = .password }
                                    .modifier(AuthField()).accessibilityIdentifier("auth-email")
                                SecureField("密码（至少 8 位）", text: $password)
                                    .textContentType(creating ? .newPassword : .password)
                                    .focused($focused, equals: .password).submitLabel(creating ? .next : .go).onSubmit { if creating { focused = .code } else { submit() } }
                                    .modifier(AuthField()).accessibilityIdentifier("auth-password")
                                if creating {
                                    HStack(spacing: 10) {
                                        TextField("六位邮箱验证码", text: $verificationCode)
                                            .keyboardType(.numberPad).textContentType(.oneTimeCode)
                                            .focused($focused, equals: .code).modifier(AuthField())
                                            .onChange(of: verificationCode) { _, value in
                                                verificationCode = String(value.filter { $0.isASCII && $0.isNumber }.prefix(6))
                                            }
                                            .accessibilityIdentifier("auth-verification-code")
                                        Button(codeSeconds > 0 ? "\(codeSeconds) 秒后重发" : "获取验证码") {
                                            Task {
                                                if let seconds = await account.requestRegistrationCode(email: email) {
                                                    codeResendAt = Date().addingTimeInterval(TimeInterval(seconds))
                                                    codeSeconds = seconds; codeSent = true; focused = .code
                                                }
                                            }
                                        }
                                        .font(.system(size: 13, weight: .medium)).frame(width: 102, height: 48)
                                        .background(Color.primary.opacity(0.045), in: RoundedRectangle(cornerRadius: 10))
                                        .disabled(account.busy || account.checking || codeSeconds > 0 || !email.contains("@"))
                                        .accessibilityIdentifier("auth-send-code")
                                    }
                                    if codeSent {
                                        Text("验证码已发送，10 分钟内有效，请留意垃圾邮件。")
                                            .font(.caption).foregroundStyle(.secondary)
                                            .frame(maxWidth: .infinity, alignment: .leading)
                                    }
                                }
                                if let error = account.error {
                                    Text(error).font(.subheadline).foregroundStyle(.red)
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                        .accessibilityIdentifier("auth-error")
                                }
                                Button(action: submit) {
                                    HStack {
                                        Spacer()
                                        Text(account.checking ? "正在恢复登录…" : account.busy ? "处理中…" : creating ? "创建账户" : "登录").font(.system(size: 15, weight: .semibold))
                                        Spacer()
                                        if account.busy || account.checking { ProgressView().tint(.white) }
                                        else { Image(systemName: "arrow.right") }
                                    }
                                    .padding(.horizontal, 18).frame(height: 50).foregroundStyle(.white)
                                    .background(ShiyanAuthPalette.gradient, in: RoundedRectangle(cornerRadius: 12))
                                }
                                .buttonStyle(.plain).disabled(!valid || account.busy || account.checking).opacity(valid && !account.busy && !account.checking ? 1 : 0.55)
                                .accessibilityIdentifier("auth-submit")
                            }
                            if !bootstrap && (account.status?.registrationEnabled != false || registering) {
                                HStack(spacing: 6) {
                                    Text(registering ? "已有账户？" : "还没有账户？").foregroundStyle(.secondary)
                                    Button(registering ? "返回登录" : "创建账户") {
                                        registering.toggle(); password = ""; verificationCode = ""; account.error = nil
                                    }
                                    .foregroundStyle(ShiyanAuthPalette.indigo).disabled(account.busy || account.checking)
                                }
                                .font(.system(size: 14)).frame(maxWidth: .infinity)
                                .padding(.top, 21).overlay(alignment: .top) { Divider() }.padding(.top, 24)
                            }
                        }
                        .padding(.horizontal, geometry.size.width < 480 ? 20 : 36)
                        .padding(.top, geometry.size.width < 480 ? 28 : 36).padding(.bottom, geometry.size.width < 480 ? 24 : 30)
                        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 24))
                        .overlay { RoundedRectangle(cornerRadius: 24).stroke(.white.opacity(scheme == .dark ? 0.12 : 0.65), lineWidth: 1) }
                        .shadow(color: ShiyanAuthPalette.indigo.opacity(0.08), radius: 28, y: 14)
                        if account.error != nil && !account.checking {
                            HStack(spacing: 10) {
                                Text("连接暂时中断").foregroundStyle(.secondary)
                                Button("重试") { Task { await account.validate(retryTransientFailure: true); if account.user == nil { await account.refreshStatus() } } }
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
    private func ellipse(_ color: Color, x: CGFloat, y: CGFloat) -> some View {
        Ellipse().fill(color).frame(width: 330, height: 380).position(x: x, y: y)
    }
    private func submit() {
        guard valid, !account.busy, !account.checking else { return }
        focused = nil
        Task {
            await account.authenticate(email: email, password: password, displayName: displayName, register: creating, bootstrap: bootstrap, verificationCode: verificationCode)
            if account.user != nil { password = "" }
        }
    }
    private struct AuthField: ViewModifier {
        func body(content: Content) -> some View {
            content.font(.system(size: 15)).padding(.horizontal, 14).frame(height: 48)
                .background(Color.primary.opacity(0.045), in: RoundedRectangle(cornerRadius: 10))
                .overlay { RoundedRectangle(cornerRadius: 10).stroke(Color.primary.opacity(0.1), lineWidth: 1) }
        }
    }
}
