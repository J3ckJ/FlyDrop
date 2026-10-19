import XCTest
import PultProtocol

final class ProtocolTests: XCTestCase {
    func testPairCodeAndShutdownHold() throws {
        let pair = try PultCodec.encode(id: "1", type: .pair, payload: ["code": .string("123456"), "name": .string("iPhone")])
        let decoded = try PultCodec.decode(pair)
        XCTAssertEqual(decoded.type, .pair)
        XCTAssertEqual(decoded.payload["code"], .string("123456"))
        XCTAssertThrowsError(try PultCodec.encode(id: "1", type: .pair, payload: ["code": .string("12")]))
        XCTAssertEqual(PultCodec.validate(type: .powerAction, payload: ["action": .string("shutdown")]), "Выключение только удержанием")
        XCTAssertNil(PultCodec.validate(type: .powerAction, payload: ["action": .string("shutdown"), "hold": .bool(true)]))
    }

    func testUnknownCommandAndMac() throws {
        XCTAssertThrowsError(try PultCodec.decode("{\"v\":1,\"type\":\"nope\",\"payload\":{}}"))
        XCTAssertTrue(PultCodec.isMac("b8:27:eb:00:00:01"))
        XCTAssertFalse(PultCodec.isMac("nope"))
        XCTAssertEqual(PultCodec.serviceType, "_pult._tcp")
        XCTAssertEqual(PultCodec.webSocketPath, "/pult")
    }

    func testFrameRoundTrip() throws {
        let jpeg = Data([0xff, 0xd8, 0xff, 0xd9])
        let encoded = try FrameCodec.encode(jpeg: jpeg, seq: 7, width: 2, height: 3)
        XCTAssertEqual(encoded[encoded.startIndex], 0x01)
        let frame = try FrameCodec.decode(encoded)
        XCTAssertEqual(frame.seq, 7)
        XCTAssertEqual(frame.width, 2)
        XCTAssertEqual(frame.height, 3)
        XCTAssertEqual(frame.jpeg, jpeg)
    }

    func testZipMatchesAgentBytes() throws {
        let zip = try ZipStore.archive([ZipEntry(name: "a.txt", data: Data("hi".utf8))])
        let expected = Data(base64Encoded: "UEsDBBQAAAgAAAAAAACsKpPYAgAAAAIAAAAFAAAAYS50eHRoaVBLAQIUABQAAAgAAAAAAACsKpPYAgAAAAIAAAAFAAAAAAAAAAAAAAAAAAAAAABhLnR4dFBLBQYAAAAAAQABADMAAAAlAAAAAAA=")!
        XCTAssertEqual(zip, expected)
        XCTAssertThrowsError(try ZipStore.archive([ZipEntry(name: "../secret", data: Data())]))
        XCTAssertThrowsError(try ZipStore.archive([]))
    }
}
