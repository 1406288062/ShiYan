import SwiftUI
import UIKit
import UIKit

 
struct AgentConversationBubble: Shape {
    func path(in rect: CGRect) -> Path {
        var p = Path()
        p.move(to: CGPoint(x: 5.0, y: 18.2))
        p.addCurve(to: CGPoint(x: 2.0, y: 11.7), control1: CGPoint(x: 3.0, y: 16.4), control2: CGPoint(x: 2.0, y: 14.4))
        p.addCurve(to: CGPoint(x: 12.0, y: 2.0), control1: CGPoint(x: 2.0, y: 6.3), control2: CGPoint(x: 6.4, y: 2.0))
        p.addCurve(to: CGPoint(x: 22.0, y: 11.7), control1: CGPoint(x: 17.6, y: 2.0), control2: CGPoint(x: 22.0, y: 6.3))
        p.addCurve(to: CGPoint(x: 12.0, y: 21.2), control1: CGPoint(x: 22.0, y: 17.2), control2: CGPoint(x: 17.5, y: 21.2))
        p.addCurve(to: CGPoint(x: 7.7, y: 20.3), control1: CGPoint(x: 10.5, y: 21.2), control2: CGPoint(x: 9.0, y: 20.9))
        p.addLine(to: CGPoint(x: 2.8, y: 21.7))
        p.addLine(to: CGPoint(x: 5.0, y: 18.2))
        p.closeSubpath()
        return p.applying(CGAffineTransform(scaleX: rect.width / 24, y: rect.height / 24).translatedBy(x: rect.minX, y: rect.minY))
    }
}

enum AgentMenuIcons {
    static let rename = draw("rename")
    static let pin = draw("pin")
    static let unpin = draw("unpin")
    static let folder = draw("folder")
    static let folderRemove = draw("folderRemove")
    static let project = draw("project")
    /// 与侧边栏、顶部的新聊天按钮同一个符号和粗细。
    static let newChat: UIImage = UIImage(systemName: "square.and.pencil", withConfiguration: UIImage.SymbolConfiguration(pointSize: 17, weight: .semibold))!.withRenderingMode(.alwaysTemplate)
    private static func draw(_ name: String) -> UIImage {
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: 24, height: 24))
        return renderer.image { context in
            let c = context.cgContext
            c.setStrokeColor(UIColor.black.cgColor)
            c.setLineWidth(1.6); c.setLineCap(.round); c.setLineJoin(.round)
            if name == "rename" {
                c.move(to: CGPoint(x: 4.5, y: 19.5)); c.addLine(to: CGPoint(x: 5.5, y: 15.5))
                c.addLine(to: CGPoint(x: 16.8, y: 4.2))
                c.addCurve(to: CGPoint(x: 19.3, y: 4.2), control1: CGPoint(x: 17.49, y: 3.51), control2: CGPoint(x: 18.61, y: 3.51))
                c.addLine(to: CGPoint(x: 19.8, y: 4.7))
                c.addCurve(to: CGPoint(x: 19.8, y: 7.2), control1: CGPoint(x: 20.49, y: 5.39), control2: CGPoint(x: 20.49, y: 6.51))
                c.addLine(to: CGPoint(x: 8.5, y: 18.5)); c.closePath()
                c.move(to: CGPoint(x: 14.8, y: 6.2)); c.addLine(to: CGPoint(x: 17.8, y: 9.2)); c.strokePath()
            } else if name == "folder" || name == "folderRemove" || name == "project" {
                c.move(to: CGPoint(x: 3, y: 8)); c.addLine(to: CGPoint(x: 3, y: 6))
                c.addCurve(to: CGPoint(x: 5, y: 4), control1: CGPoint(x: 3, y: 4.895), control2: CGPoint(x: 3.895, y: 4))
                c.addLine(to: CGPoint(x: 9, y: 4)); c.addLine(to: CGPoint(x: 11, y: 6)); c.addLine(to: CGPoint(x: 19, y: 6))
                c.addCurve(to: CGPoint(x: 21, y: 8), control1: CGPoint(x: 20.105, y: 6), control2: CGPoint(x: 21, y: 6.895))
                if name != "folder" { c.addLine(to: CGPoint(x: 21, y: name == "project" ? 11 : 13)) }
                c.strokePath()
                c.move(to: CGPoint(x: 3, y: 8)); c.addLine(to: CGPoint(x: 21, y: 8)); c.strokePath()
                c.move(to: CGPoint(x: 3, y: 8)); c.addLine(to: CGPoint(x: 3, y: 18))
                c.addCurve(to: CGPoint(x: 5, y: 20), control1: CGPoint(x: 3, y: 19.105), control2: CGPoint(x: 3.895, y: 20))
                if name == "folder" {
                    c.addLine(to: CGPoint(x: 19, y: 20))
                    c.addCurve(to: CGPoint(x: 21, y: 18), control1: CGPoint(x: 20.105, y: 20), control2: CGPoint(x: 21, y: 19.105))
                    c.addLine(to: CGPoint(x: 21, y: 8))
                } else { c.addLine(to: CGPoint(x: 12, y: 20)) }
                c.strokePath()
                if name == "folderRemove" {
                    c.move(to: CGPoint(x: 16, y: 16)); c.addLine(to: CGPoint(x: 21, y: 21))
                    c.move(to: CGPoint(x: 21, y: 16)); c.addLine(to: CGPoint(x: 16, y: 21)); c.strokePath()
                } else if name == "project" {
                    c.move(to: CGPoint(x: 14, y: 17)); c.addLine(to: CGPoint(x: 21, y: 17))
                    c.move(to: CGPoint(x: 18, y: 14)); c.addLine(to: CGPoint(x: 21, y: 17)); c.addLine(to: CGPoint(x: 18, y: 20)); c.strokePath()
                }
            } else {
                c.saveGState(); c.translateBy(x: 12, y: 12); c.rotate(by: .pi / 4); c.translateBy(x: -12, y: -12)
                c.move(to: CGPoint(x: 8, y: 3)); c.addLine(to: CGPoint(x: 16, y: 3))
                c.addLine(to: CGPoint(x: 16, y: 9.8)); c.addLine(to: CGPoint(x: 18, y: 12))
                c.addLine(to: CGPoint(x: 19, y: 16.5)); c.addLine(to: CGPoint(x: 5, y: 16.5))
                c.addLine(to: CGPoint(x: 6, y: 12)); c.addLine(to: CGPoint(x: 8, y: 9.8)); c.closePath()
                c.move(to: CGPoint(x: 12, y: 16.5)); c.addLine(to: CGPoint(x: 12, y: 22)); c.strokePath(); c.restoreGState()
                if name == "unpin" { c.move(to: CGPoint(x: 3, y: 3)); c.addLine(to: CGPoint(x: 21, y: 21)); c.strokePath() }
            }
        }.withRenderingMode(.alwaysTemplate)
    }
}

 
struct AgentReplyCopyIcon: Shape {
    func path(in rect: CGRect) -> Path {
        var p = Path()
         
        p.move(to: CGPoint(x: 16, y: 14))
        p.addLine(to: CGPoint(x: 16, y: 10))
        p.addCurve(to: CGPoint(x: 23, y: 3), control1: CGPoint(x: 16, y: 5.5), control2: CGPoint(x: 18.5, y: 3))
        p.addLine(to: CGPoint(x: 38, y: 3))
        p.addCurve(to: CGPoint(x: 45, y: 10), control1: CGPoint(x: 42.5, y: 3), control2: CGPoint(x: 45, y: 5.5))
        p.addLine(to: CGPoint(x: 45, y: 26))
        p.addCurve(to: CGPoint(x: 38, y: 33), control1: CGPoint(x: 45, y: 30.5), control2: CGPoint(x: 42.5, y: 33))
        p.addLine(to: CGPoint(x: 34, y: 33))
        p.addRoundedRect(in: CGRect(x: 3, y: 15, width: 31, height: 30),
                         cornerSize: CGSize(width: 7, height: 7))
        return p.applying(CGAffineTransform(scaleX: rect.width / 48, y: rect.height / 48)
            .concatenating(CGAffineTransform(translationX: rect.minX, y: rect.minY)))
    }
}

 
enum AgentCopyStyle {
    static let menuImage: UIImage = {
        let size: CGFloat = 18
        let format = UIGraphicsImageRendererFormat(); format.opaque = false
        return UIGraphicsImageRenderer(size: CGSize(width: size, height: size), format: format).image { context in
            context.cgContext.addPath(AgentReplyCopyIcon().path(in: CGRect(x: 0, y: 0, width: size, height: size)).cgPath)
            context.cgContext.setStrokeColor(UIColor.label.cgColor)
            context.cgContext.setLineWidth(1.3) // 与菜单里系统图标（常规粗细）一致
            context.cgContext.setLineCap(.round); context.cgContext.setLineJoin(.round)
            context.cgContext.strokePath()
        }.withRenderingMode(.alwaysTemplate)
    }()
}
