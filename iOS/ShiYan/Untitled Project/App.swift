import SwiftUI

@main
struct ShiYanApp: App {
    @State private var showSplash = true

    var body: some Scene {
        WindowGroup {
            ZStack {
                ShiyanAccountRoot()
                    .opacity(showSplash ? 0 : 1)

                if showSplash {
                    Color.black.ignoresSafeArea()
                    if let img = UIImage(named: "LaunchImage"),
                       let cg = img.cgImage {
                        Image(decorative: cg, scale: 1.0)
                            .resizable().scaledToFill()
                            .ignoresSafeArea()
                    }
                }
            }
            .task {
                try? await Task.sleep(for: .seconds(2))
                withAnimation(.easeInOut(duration: 0.4)) { showSplash = false }
            }
        }
    }
}
