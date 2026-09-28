// 用 macOS Vision 找照片里的卡片四角,输出像素坐标 JSON:[[x,y] × 4],顺序 左上/右上/右下/左下
import Foundation
import Vision
import ImageIO

let url = URL(fileURLWithPath: CommandLine.arguments[1])
guard let src = CGImageSourceCreateWithURL(url as CFURL, nil),
      let img = CGImageSourceCreateImageAtIndex(src, 0, nil) else {
    FileHandle.standardError.write("读不了图片\n".data(using: .utf8)!); exit(1)
}

// 只要粗定位(精修在 scan.ts),参数放宽:收紧后实测贴边的卡会整张漏检
let req = VNDetectRectanglesRequest()
req.maximumObservations = 5
req.minimumSize = 0.1            // 实测设 0.3 会把整卡框也滤掉(Vision 怪癖);小框靠下面取最大面积排除
req.minimumAspectRatio = 0.3     // ID-1 卡 54/85.6 ≈ 0.63,透视会让它偏离
req.maximumAspectRatio = 1
req.quadratureTolerance = 45     // 上限值;粗框本身常不准(实测一角偏 75px),30° 会把整卡框滤掉
req.minimumConfidence = 0
try VNImageRequestHandler(cgImage: img).perform([req])

// 多个候选(卡内的表格框、照片框也是矩形)取面积最大的
let area = { (r: VNRectangleObservation) in r.boundingBox.width * r.boundingBox.height }
guard let r = req.results?.max(by: { area($0) < area($1) }) else {
    FileHandle.standardError.write("没找到卡片\n".data(using: .utf8)!); exit(2)
}
// Vision 坐标归一化且原点在左下,换成像素 + 左上原点
let (w, h) = (Double(img.width), Double(img.height))
let pts = [r.topLeft, r.topRight, r.bottomRight, r.bottomLeft].map { [($0.x * w).rounded(), ((1 - $0.y) * h).rounded()] }
print(String(data: try JSONSerialization.data(withJSONObject: pts), encoding: .utf8)!)
