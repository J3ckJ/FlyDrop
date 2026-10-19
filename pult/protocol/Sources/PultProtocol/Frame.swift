import Foundation

public struct ScreenFrame: Equatable, Sendable {
    public var seq: Int
    public var width: Int
    public var height: Int
    public var jpeg: Data

    public init(seq: Int, width: Int, height: Int, jpeg: Data) {
        self.seq = seq
        self.width = width
        self.height = height
        self.jpeg = jpeg
    }
}

public enum FrameCodec {
    public static func encode(jpeg: Data, seq: Int, width: Int, height: Int) throws -> Data {
        let header = Data("{\"seq\":\(seq),\"width\":\(width),\"height\":\(height)}".utf8)
        if header.count > 65535 { throw PultProtocolError.message("Слишком большой заголовок кадра") }
        var out = Data(capacity: 3 + header.count + jpeg.count)
        out.append(0x01)
        out.append(UInt8((header.count >> 8) & 0xff))
        out.append(UInt8(header.count & 0xff))
        out.append(header)
        out.append(jpeg)
        return out
    }

    public static func decode(_ buffer: Data) throws -> ScreenFrame {
        if buffer.count < 5 || buffer[buffer.startIndex] != 0x01 {
            throw PultProtocolError.message("Некорректный кадр")
        }
        let length = Int(buffer[buffer.startIndex + 1]) << 8 | Int(buffer[buffer.startIndex + 2])
        if 3 + length > buffer.count { throw PultProtocolError.message("Кадр обрезан") }
        let header = buffer.subdata(in: buffer.startIndex + 3 ..< buffer.startIndex + 3 + length)
        let meta: JSON
        do { meta = try JSONDecoder().decode(JSON.self, from: header) }
        catch { throw PultProtocolError.message("Некорректный кадр") }
        guard let object = meta.object, let seq = object["seq"]?.int, let width = object["width"]?.int, let height = object["height"]?.int else {
            throw PultProtocolError.message("Некорректный кадр")
        }
        let jpeg = buffer.subdata(in: buffer.startIndex + 3 + length ..< buffer.endIndex)
        return ScreenFrame(seq: seq, width: width, height: height, jpeg: jpeg)
    }
}
