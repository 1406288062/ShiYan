import CoreML

 
final class ESRGANEngine: @unchecked Sendable {
    enum Model: String, CaseIterable {
        case x4 = "RealESRGAN_x4plus"
        case x4anime = "RealESRGAN_x4plus_anime"

        var label: String {
            switch self {
            case .x4: "通用增强"
            case .x4anime: "动漫增强"
            }
        }

        var subtitle: String {
            switch self {
            case .x4: "提升清晰度与细节"
            case .x4anime: "色彩更生动"
            }
        }
    }

    private var models: [Model: MLModel] = [:]

    func loadModel(_ modelKey: Model) -> MLModel? {
        if let m = models[modelKey] { return m }
        guard let url = Bundle.main.url(forResource: modelKey.rawValue, withExtension: "mlmodelc") else {
            print("❌ 模型未找到: \(modelKey.rawValue).mlmodelc")
            return nil
        }
        do {
            let compiled = try MLModel(contentsOf: url)
            models[modelKey] = compiled
            print("✅ 加载成功: \(modelKey.rawValue)")
            return compiled
        } catch {
            print("❌ 加载失败: \(modelKey.rawValue) — \(error)")
            return nil
        }
    }

    func enhance(_ cgImage: CGImage, model: Model, onProgress: @escaping (Double) -> Void) async -> CGImage? {
        guard let mlModel = loadModel(model) else { return nil }
        return await process(cgImage, mlModel: mlModel, onProgress: onProgress)
    }

    private func process(_ cgImage: CGImage, mlModel: MLModel, onProgress: (Double) -> Void) async -> CGImage? {
        let w = cgImage.width, h = cgImage.height
        let maxTile = 400
        if w > maxTile || h > maxTile {
            return await tiledProcess(cgImage, mlModel: mlModel, tileSize: maxTile, onProgress: onProgress)
        }
        guard let input = preprocess(cgImage) else { return nil }
        guard let output = try? await mlModel.prediction(from: input),
              let outArray = output.featureValue(for: "output")?.multiArrayValue else { return nil }
        onProgress(1.0)
        guard let raw = arrayToCGImage(outArray, origW: w * 4, origH: h * 4) else { return nil }
        return raw
    }

     

    private func tiledProcess(_ cgImage: CGImage, mlModel: MLModel, tileSize: Int, onProgress: (Double) -> Void) async -> CGImage? {
        let w = cgImage.width, h = cgImage.height
        let pad = 10
        let outW = w * 4, outH = h * 4

         
        var outBuf = [UInt8](repeating: 0, count: outW * outH * 4)

        let xSteps = Int(ceil(Double(w) / Double(tileSize)))
        let ySteps = Int(ceil(Double(h) / Double(tileSize)))
        let totalTiles = xSteps * ySteps
        var completed = 0

        for yi in 0..<ySteps {
            for xi in 0..<xSteps {
                if Task.isCancelled { return nil }

                let x = xi * tileSize
                let y = yi * tileSize

                let x1 = max(0, x - pad), y1 = max(0, y - pad)
                let x2 = min(w, x + tileSize + pad), y2 = min(h, y + tileSize + pad)
                let tileW = x2 - x1, tileH = y2 - y1

                let cgY = h - y2
                guard let tile = cgImage.cropping(to: CGRect(x: x1, y: cgY, width: tileW, height: tileH)) else { continue }
                guard let input = preprocess(tile) else { continue }
                guard let output = try? await mlModel.prediction(from: input),
                      let outArray = output.featureValue(for: "output")?.multiArrayValue else { continue }

                let px1 = (x - x1) * 4, py1 = (y - y1) * 4
                let effW = min(tileSize, w - x) * 4
                let effH = min(tileSize, h - y) * 4

                guard let tileBuf = mlArrayToRGBA(outArray) else { continue }
                let tileStride = tileW * 4 * 4   
                let dstX = x * 4

                 
                 
                for dy in 0..<effH {
                    let srcRow = tileH * 4 - 1 - py1 - dy
                    let dstRow = outH - 1 - y * 4 - dy

                    let srcOff = srcRow * tileStride + px1 * 4
                    let dstOff = dstRow * outW * 4 + dstX * 4
                    let srcBase = tileBuf.withUnsafeBytes { $0.baseAddress! + srcOff }
                    let dstBase = outBuf.withUnsafeMutableBytes { $0.baseAddress! + dstOff }
                    memcpy(dstBase, srcBase, effW * 4)
                }

                completed += 1
                onProgress(Double(completed) / Double(totalTiles))
            }
        }

        guard let rawCtx = CGContext(data: &outBuf, width: outW, height: outH,
                                      bitsPerComponent: 8, bytesPerRow: outW * 4,
                                      space: CGColorSpaceCreateDeviceRGB(),
                                      bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue),
              let rawImg = rawCtx.makeImage() else { return nil }
        return rawImg
    }

     
    private func mlArrayToRGBA(_ array: MLMultiArray) -> [UInt8]? {
        let shape = array.shape.map { $0.intValue }
        guard shape.count == 4 else { return nil }
        let h = shape[2], w = shape[3]
        let chw = h * w

        let ptr = array.dataPointer.assumingMemoryBound(to: UInt16.self)
        var rgba = [UInt8](repeating: 0, count: 4 * w * h)
        for y in 0..<h {
            for x in 0..<w {
                let dst = (y * w + x) * 4
                rgba[dst]     = UInt8(min(max(float16to32(ptr[0 * chw + y * w + x]), 0), 1) * 255)
                rgba[dst + 1] = UInt8(min(max(float16to32(ptr[1 * chw + y * w + x]), 0), 1) * 255)
                rgba[dst + 2] = UInt8(min(max(float16to32(ptr[2 * chw + y * w + x]), 0), 1) * 255)
                rgba[dst + 3] = 255
            }
        }
        return rgba
    }

     

    private func preprocess(_ cgImage: CGImage) -> MLFeatureProvider? {
        let w = cgImage.width, h = cgImage.height

        let colorSpace = CGColorSpaceCreateDeviceRGB()
        let bitmapInfo = CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipLast.rawValue)
        guard let ctx = CGContext(data: nil, width: w, height: h,
                                   bitsPerComponent: 8, bytesPerRow: w * 4,
                                   space: colorSpace, bitmapInfo: bitmapInfo.rawValue) else { return nil }
        ctx.draw(cgImage, in: CGRect(x: 0, y: 0, width: w, height: h))
        guard let rendered = ctx.makeImage(),
              let provider = rendered.dataProvider,
              let cfData = provider.data,
              let ptr = CFDataGetBytePtr(cfData) else { return nil }

        guard let array = try? MLMultiArray(shape: [1, 3, NSNumber(value: h), NSNumber(value: w)], dataType: .float32) else { return nil }
        for y in 0..<h {
            for x in 0..<w {
                let src = (y * w + x) * 4
                let base = y * w + x
                array[0 * h * w + base] = NSNumber(value: Float(ptr[src]) / 255.0)
                array[1 * h * w + base] = NSNumber(value: Float(ptr[src + 1]) / 255.0)
                array[2 * h * w + base] = NSNumber(value: Float(ptr[src + 2]) / 255.0)
            }
        }
        return try? MLDictionaryFeatureProvider(dictionary: ["image": array])
    }

     

    private func arrayToCGImage(_ array: MLMultiArray, origW: Int, origH: Int) -> CGImage? {
        let shape = array.shape.map { $0.intValue }
        guard shape.count == 4 else { return nil }
        let h = shape[2], w = shape[3]
        let chw = h * w

        let ptr = array.dataPointer.assumingMemoryBound(to: UInt16.self)
        var rgb = [UInt8](repeating: 0, count: 4 * w * h)
        for y in 0..<h {
            for x in 0..<w {
                let dst = (y * w + x) * 4
                rgb[dst]     = UInt8(min(max(float16to32(ptr[0 * chw + y * w + x]), 0), 1) * 255)
                rgb[dst + 1] = UInt8(min(max(float16to32(ptr[1 * chw + y * w + x]), 0), 1) * 255)
                rgb[dst + 2] = UInt8(min(max(float16to32(ptr[2 * chw + y * w + x]), 0), 1) * 255)
                rgb[dst + 3] = 255
            }
        }

        guard let ctx = CGContext(data: &rgb, width: w, height: h,
                                   bitsPerComponent: 8, bytesPerRow: w * 4,
                                   space: CGColorSpaceCreateDeviceRGB(),
                                   bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return nil }
        return ctx.makeImage()?.cropping(to: CGRect(x: 0, y: 0, width: min(origW, w), height: min(origH, h)))
    }

     
    private func flipCGImage(_ image: CGImage, width: Int? = nil, height: Int? = nil) -> CGImage? {
        let w = width ?? image.width, h = height ?? image.height
        guard let ctx = CGContext(data: nil, width: w, height: h,
                                   bitsPerComponent: 8, bytesPerRow: w * 4,
                                   space: CGColorSpaceCreateDeviceRGB(),
                                   bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return nil }
        ctx.translateBy(x: 0, y: CGFloat(h))
        ctx.scaleBy(x: 1, y: -1)
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
        return ctx.makeImage()
    }

     
    private func float16to32(_ v: UInt16) -> Float {
        let sign = Float((v >> 15) & 1) * -2 + 1
        let exp = Int((v >> 10) & 0x1F)
        let mant = Float(v & 0x3FF) / 1024.0
        if exp == 0 { return sign * powf(2, -14) * mant }
        if exp == 31 { return mant == 0 ? sign * .infinity : .nan }
        return sign * powf(2, Float(exp - 15)) * (1 + mant)
    }
}
