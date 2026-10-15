import SwiftUI

 
struct AgentCalloutShape: Shape {
    var pointsDown = true
    func path(in rect: CGRect) -> Path {
        let r: CGFloat = min(24, rect.width / 4)
        let tip: CGFloat = 12
        let top = pointsDown ? rect.minY : rect.minY + tip
        let bottom = pointsDown ? rect.maxY - tip : rect.maxY
        let left = rect.minX, right = rect.maxX, mid = rect.midX
        var p = Path()
        p.move(to: CGPoint(x: left + r, y: top))
        if !pointsDown {
            p.addLine(to: CGPoint(x: mid - 13, y: top))
            p.addQuadCurve(to: CGPoint(x: mid - 5, y: top - 6), control: CGPoint(x: mid - 8, y: top))
            p.addQuadCurve(to: CGPoint(x: mid + 5, y: top - 6), control: CGPoint(x: mid, y: rect.minY - 4))
            p.addQuadCurve(to: CGPoint(x: mid + 13, y: top), control: CGPoint(x: mid + 8, y: top))
        }
        p.addLine(to: CGPoint(x: right - r, y: top))
        p.addQuadCurve(to: CGPoint(x: right, y: top + r), control: CGPoint(x: right, y: top))
        p.addLine(to: CGPoint(x: right, y: bottom - r))
        p.addQuadCurve(to: CGPoint(x: right - r, y: bottom), control: CGPoint(x: right, y: bottom))
        if pointsDown {
            p.addLine(to: CGPoint(x: mid + 13, y: bottom))
            p.addQuadCurve(to: CGPoint(x: mid + 5, y: bottom + 6), control: CGPoint(x: mid + 8, y: bottom))
            p.addQuadCurve(to: CGPoint(x: mid - 5, y: bottom + 6), control: CGPoint(x: mid, y: rect.maxY + 4))
            p.addQuadCurve(to: CGPoint(x: mid - 13, y: bottom), control: CGPoint(x: mid - 8, y: bottom))
        }
        p.addLine(to: CGPoint(x: left + r, y: bottom))
        p.addQuadCurve(to: CGPoint(x: left, y: bottom - r), control: CGPoint(x: left, y: bottom))
        p.addLine(to: CGPoint(x: left, y: top + r))
        p.addQuadCurve(to: CGPoint(x: left + r, y: top), control: CGPoint(x: left, y: top))
        p.closeSubpath()
        return p
    }
}
