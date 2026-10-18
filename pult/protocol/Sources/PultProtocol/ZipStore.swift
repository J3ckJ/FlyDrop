import Foundation

public struct ZipEntry: Equatable, Sendable {
    public var name: String
    public var data: Data

    public init(name: String, data: Data) {
        self.name = name
        self.data = data
    }
}

public enum ZipStore {
    public static func archive(_ entries: [ZipEntry], maxFiles: Int = 500, maxBytes: Int = 1024 * 1024 * 1024) throws -> Data {
        if entries.isEmpty { throw PultProtocolError.message("Папка пустая") }
        if entries.count > maxFiles { throw PultProtocolError.message("В папке слишком много файлов. Можно до 500") }
        var total = 0
        var locals: [Data] = []
        var centrals: [Data] = []
        var offset = 0
        for entry in entries {
            let name = try safeName(entry.name)
            total += entry.data.count
            if total > maxBytes { throw PultProtocolError.message("Папка больше 1 ГБ. Она не отправлена") }
            let crc = crc32(entry.data)
            var local = Data(count: 30)
            writeUInt32(&local, 0, 0x04034b50)
            writeUInt16(&local, 4, 20)
            writeUInt16(&local, 6, 0x800)
            writeUInt32(&local, 14, crc)
            writeUInt32(&local, 18, UInt32(entry.data.count))
            writeUInt32(&local, 22, UInt32(entry.data.count))
            writeUInt16(&local, 26, UInt16(name.count))
            local.append(name)
            local.append(entry.data)
            var central = Data(count: 46)
            writeUInt32(&central, 0, 0x02014b50)
            writeUInt16(&central, 4, 20)
            writeUInt16(&central, 6, 20)
            writeUInt16(&central, 8, 0x800)
            writeUInt32(&central, 16, crc)
            writeUInt32(&central, 20, UInt32(entry.data.count))
            writeUInt32(&central, 24, UInt32(entry.data.count))
            writeUInt16(&central, 28, UInt16(name.count))
            writeUInt32(&central, 42, UInt32(offset))
            central.append(name)
            offset += local.count
            locals.append(local)
            centrals.append(central)
        }
        var centralDir = Data()
        for part in centrals { centralDir.append(part) }
        var end = Data(count: 22)
        writeUInt32(&end, 0, 0x06054b50)
        writeUInt16(&end, 8, UInt16(entries.count))
        writeUInt16(&end, 10, UInt16(entries.count))
        writeUInt32(&end, 12, UInt32(centralDir.count))
        writeUInt32(&end, 16, UInt32(offset))
        var result = Data()
        for part in locals { result.append(part) }
        result.append(centralDir)
        result.append(end)
        return result
    }

    private static func safeName(_ name: String) throws -> Data {
        if name.isEmpty || name.count > 240 { throw PultProtocolError.message("Некорректное имя в папке") }
        let normalized = name.replacingOccurrences(of: "\\", with: "/")
        if normalized.hasPrefix("/") || normalized.split(separator: "/", omittingEmptySubsequences: false).contains(where: { $0.isEmpty || $0 == "." || $0 == ".." }) {
            throw PultProtocolError.message("Некорректный путь в папке")
        }
        return Data(normalized.utf8)
    }

    public static func crc32(_ buffer: Data) -> UInt32 {
        var crc: UInt32 = 0xffff_ffff
        for byte in buffer {
            let index = Int((crc ^ UInt32(byte)) & 0xff)
            crc = table[index] ^ (crc >> 8)
        }
        return crc ^ 0xffff_ffff
    }

    private static let table: [UInt32] = {
        (0..<256).map { start in
            var c = UInt32(start)
            for _ in 0..<8 {
                c = (c & 1) == 1 ? (0xedb8_8320 ^ (c >> 1)) : (c >> 1)
            }
            return c
        }
    }()

    private static func writeUInt16(_ data: inout Data, _ offset: Int, _ value: UInt16) {
        data[offset] = UInt8(value & 0xff)
        data[offset + 1] = UInt8((value >> 8) & 0xff)
    }

    private static func writeUInt32(_ data: inout Data, _ offset: Int, _ value: UInt32) {
        data[offset] = UInt8(value & 0xff)
        data[offset + 1] = UInt8((value >> 8) & 0xff)
        data[offset + 2] = UInt8((value >> 16) & 0xff)
        data[offset + 3] = UInt8((value >> 24) & 0xff)
    }
}
