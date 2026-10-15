import SwiftUI

 
struct SwallowShape: Shape {
    func path(in rect: CGRect) -> Path {
        var p = Path()
        let w = rect.width, h = rect.height
        let s = min(w, h) / 600

         
        let cx = w * 0.42
        let cy = h * 0.48

         
        p.move(to: CGPoint(x: cx - 250 * s, y: cy - 155 * s))
        p.addLine(to: CGPoint(x: cx - 205 * s, y: cy - 125 * s))
         
        p.addLine(to: CGPoint(x: cx - 225 * s, y: cy - 110 * s))
        p.addLine(to: CGPoint(x: cx - 200 * s, y: cy - 105 * s))

         
        p.addCurve(to: CGPoint(x: cx - 50 * s, y: cy - 140 * s),
                   control1: CGPoint(x: cx - 150 * s, y: cy - 105 * s),
                   control2: CGPoint(x: cx - 90 * s, y: cy - 155 * s))

         
        p.addCurve(to: CGPoint(x: cx + 120 * s, y: cy - 240 * s),
                   control1: CGPoint(x: cx + 0 * s, y: cy - 190 * s),
                   control2: CGPoint(x: cx + 80 * s, y: cy - 240 * s))

         
        p.addCurve(to: CGPoint(x: cx + 260 * s, y: cy - 200 * s),
                   control1: CGPoint(x: cx + 170 * s, y: cy - 240 * s),
                   control2: CGPoint(x: cx + 230 * s, y: cy - 210 * s))

         
        p.addCurve(to: CGPoint(x: cx + 80 * s, y: cy - 100 * s),
                   control1: CGPoint(x: cx + 240 * s, y: cy - 180 * s),
                   control2: CGPoint(x: cx + 180 * s, y: cy - 120 * s))

        p.addCurve(to: CGPoint(x: cx + 40 * s, y: cy - 40 * s),
                   control1: CGPoint(x: cx + 110 * s, y: cy - 60 * s),
                   control2: CGPoint(x: cx + 70 * s, y: cy - 40 * s))

         
        p.addCurve(to: CGPoint(x: cx + 200 * s, y: cy + 30 * s),
                   control1: CGPoint(x: cx + 100 * s, y: cy + 20 * s),
                   control2: CGPoint(x: cx + 160 * s, y: cy + 30 * s))

        p.addCurve(to: CGPoint(x: cx + 230 * s, y: cy + 110 * s),
                   control1: CGPoint(x: cx + 230 * s, y: cy + 50 * s),
                   control2: CGPoint(x: cx + 260 * s, y: cy + 80 * s))

         
        p.addCurve(to: CGPoint(x: cx + 100 * s, y: cy + 40 * s),
                   control1: CGPoint(x: cx + 170 * s, y: cy + 70 * s),
                   control2: CGPoint(x: cx + 130 * s, y: cy + 50 * s))

         
        p.addCurve(to: CGPoint(x: cx + 210 * s, y: cy + 130 * s),
                   control1: CGPoint(x: cx + 150 * s, y: cy + 80 * s),
                   control2: CGPoint(x: cx + 190 * s, y: cy + 110 * s))

         
        p.addCurve(to: CGPoint(x: cx - 40 * s, y: cy - 20 * s),
                   control1: CGPoint(x: cx + 130 * s, y: cy + 90 * s),
                   control2: CGPoint(x: cx + 60 * s, y: cy + 60 * s))
        p.addCurve(to: CGPoint(x: cx - 180 * s, y: cy - 80 * s),
                   control1: CGPoint(x: cx - 100 * s, y: cy - 50 * s),
                   control2: CGPoint(x: cx - 140 * s, y: cy - 70 * s))

         
        p.addCurve(to: CGPoint(x: cx - 250 * s, y: cy - 155 * s),
                   control1: CGPoint(x: cx - 200 * s, y: cy - 90 * s),
                   control2: CGPoint(x: cx - 220 * s, y: cy - 130 * s))

        return p
    }
}

 
struct SwallowLogoView: View {
    var size: CGFloat = 40
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        ZStack {
            Circle().fill(colorScheme == .dark ? .black : .white)
            SwallowShape()
                .fill(ShiyanTheme.animeAccent)
                .frame(width: size * 0.7, height: size * 0.7)
        }
        .frame(width: size, height: size)
    }
}
