import Foundation

public enum ClientType: String, CaseIterable, Sendable {
    case hello
    case pair
    case statusGet = "status.get"
    case screenSubscribe = "screen.subscribe"
    case screenUnsubscribe = "screen.unsubscribe"
    case inputMove = "input.move"
    case inputClick = "input.click"
    case inputScroll = "input.scroll"
    case inputKey = "input.key"
    case inputText = "input.text"
    case volumeSet = "volume.set"
    case mediaCommand = "media.command"
    case appsList = "apps.list"
    case appsLaunch = "apps.launch"
    case clipboardGet = "clipboard.get"
    case clipboardSet = "clipboard.set"
    case notificationsList = "notifications.list"
    case powerAction = "power.action"
    case wolWake = "wol.wake"
    case wolScheduleList = "wol.schedule.list"
    case wolSchedulePut = "wol.schedule.put"
    case wolScheduleDelete = "wol.schedule.delete"
    case flydropProgress = "flydrop.progress"
    case flydropInfo = "flydrop.info"
}

public enum PultCodec {
    public static let version = 1
    public static let serviceType = "_pult._tcp"
    public static let webSocketPath = "/pult"
    public static let defaultPort = 4720
    public static let maxFileBytes = 1024 * 1024 * 1024
    public static let maxTextChars = 50_000
    public static let maxName = 40
    public static let maxFps = 12

    public static func isMac(_ value: String) -> Bool {
        let parts = value.split(separator: value.contains(":") ? ":" : "-", omittingEmptySubsequences: false)
        guard parts.count == 6 else { return false }
        return parts.allSatisfy { part in
            part.count == 2 && part.allSatisfy { $0.isHexDigit }
        }
    }

    public static func encode(id: String?, type: ClientType, payload: [String: JSON] = [:]) throws -> String {
        if let problem = validate(type: type, payload: payload) {
            throw PultProtocolError.message(problem)
        }
        let object: [String: JSON] = [
            "v": .int(version),
            "id": id.map(JSON.string) ?? .null,
            "type": .string(type.rawValue),
            "payload": .object(payload),
        ]
        let data = try JSONEncoder().encode(JSON.object(object))
        guard let text = String(data: data, encoding: .utf8) else {
            throw PultProtocolError.message("Некорректное сообщение")
        }
        return text
    }

    public static func decode(_ raw: String) throws -> (id: String?, type: ClientType, payload: [String: JSON]) {
        guard let data = raw.data(using: .utf8), data.count <= 256 * 1024 else {
            throw PultProtocolError.message("Слишком большое сообщение")
        }
        let parsed: JSON
        do { parsed = try JSONDecoder().decode(JSON.self, from: data) }
        catch { throw PultProtocolError.message("Некорректное сообщение") }
        guard let object = parsed.object else { throw PultProtocolError.message("Некорректное сообщение") }
        guard object["v"]?.int == version else { throw PultProtocolError.message("Неподдерживаемая версия протокола") }
        guard let typeName = object["type"]?.string, let type = ClientType(rawValue: typeName) else {
            throw PultProtocolError.message("Неизвестная команда")
        }
        let idValue = object["id"]
        let id: String?
        switch idValue {
        case .none, .null?:
            id = nil
        case .string(let value)?:
            if value.count > 64 { throw PultProtocolError.message("Некорректный идентификатор") }
            id = value
        default:
            throw PultProtocolError.message("Некорректный идентификатор")
        }
        let payload = object["payload"]?.object ?? [:]
        if object["payload"] != nil && object["payload"]?.object == nil {
            throw PultProtocolError.message("Некорректная команда")
        }
        if let problem = validate(type: type, payload: payload) {
            throw PultProtocolError.message(problem)
        }
        return (id, type, payload)
    }

    public static func validate(type: ClientType, payload: [String: JSON]) -> String? {
        switch type {
        case .hello:
            if let name = payload["name"], name != .null, name.string == nil { return "Некорректное имя" }
            if let name = payload["name"]?.string, name.count > maxName { return "Имя длиннее 40 символов" }
            if let token = payload["token"], token != .null, token.string == nil { return "Некорректный ключ" }
            if let token = payload["token"]?.string, token.count > 128 { return "Некорректный ключ" }
            return nil
        case .pair:
            guard let code = payload["code"]?.string, code.count == 6, code.allSatisfy(\.isNumber) else { return "Код — шесть цифр" }
            if let name = payload["name"], name.string == nil || (name.string?.count ?? 0) > maxName { return "Некорректное имя" }
            return nil
        case .screenSubscribe:
            if payload["fps"] == nil { return nil }
            guard let fps = payload["fps"]?.int, (1...maxFps).contains(fps) else { return "Частота кадров от 1 до 12" }
            return nil
        case .screenUnsubscribe, .statusGet, .appsList, .clipboardGet, .notificationsList, .wolScheduleList, .flydropInfo:
            return nil
        case .inputMove, .inputScroll:
            guard let dx = payload["dx"]?.double, let dy = payload["dy"]?.double else { return "Некорректное смещение" }
            if abs(dx) > 8000 || abs(dy) > 8000 { return "Слишком большое смещение" }
            return nil
        case .inputClick:
            let button = payload["button"]?.string ?? "left"
            if !["left", "right", "middle"].contains(button) { return "Некорректная кнопка" }
            if let count = payload["count"], count.int == nil || !(1...3).contains(count.int ?? 0) { return "Некорректный щелчок" }
            return nil
        case .inputKey:
            guard let key = payload["key"]?.string, allowedKey(key) else { return "Некорректная клавиша" }
            guard payload["down"]?.bool != nil else { return "Некорректное состояние клавиши" }
            if let modifiers = payload["modifiers"], modifiers.array == nil { return "Некорректные модификаторы" }
            return nil
        case .inputText:
            guard let text = payload["text"]?.string, text.count <= 2000 else { return "Слишком длинный текст" }
            return nil
        case .volumeSet:
            if let level = payload["level"], level.int == nil || !(0...100).contains(level.int ?? -1) { return "Громкость от 0 до 100" }
            if let muted = payload["muted"], muted.bool == nil { return "Некорректное состояние звука" }
            if payload["level"] == nil && payload["muted"] == nil { return "Не указана громкость" }
            return nil
        case .mediaCommand:
            guard let action = payload["action"]?.string, ["play", "pause", "toggle", "next", "previous"].contains(action) else {
                return "Неизвестная команда плеера"
            }
            return nil
        case .appsLaunch:
            guard let id = payload["id"]?.string, !id.trimmingCharacters(in: .whitespaces).isEmpty, id.count <= 300 else {
                return "Некорректное приложение"
            }
            return nil
        case .clipboardSet:
            guard let text = payload["text"]?.string, text.count <= maxTextChars else { return "Текст буфера длиннее 50 000 символов" }
            return nil
        case .powerAction:
            guard let action = payload["action"]?.string, ["sleep", "lock", "restart", "shutdown"].contains(action) else {
                return "Неизвестное действие питания"
            }
            if action == "shutdown" && payload["hold"]?.bool != true { return "Выключение только удержанием" }
            if let force = payload["force"], force.bool == nil { return "Некорректное подтверждение" }
            return nil
        case .wolWake:
            guard let mac = payload["mac"]?.string, isMac(mac) else { return "Некорректный MAC-адрес" }
            return nil
        case .wolSchedulePut:
            guard let mac = payload["mac"]?.string, isMac(mac) else { return "Некорректный MAC-адрес" }
            guard let label = payload["label"]?.string, !label.isEmpty, label.count <= 80 else { return "Введите название сценария" }
            guard let hour = payload["hour"]?.int, (0...23).contains(hour) else { return "Час от 0 до 23" }
            guard let minute = payload["minute"]?.int, (0...59).contains(minute) else { return "Минута от 0 до 59" }
            if let id = payload["id"], id.string == nil || (id.string?.count ?? 0) > 64 { return "Некорректный сценарий" }
            return nil
        case .wolScheduleDelete:
            guard let id = payload["id"]?.string, !id.isEmpty else { return "Некорректный сценарий" }
            return nil
        case .flydropProgress:
            guard let name = payload["name"]?.string, name.count <= 180 else { return "Некорректное имя файла" }
            guard let state = payload["state"]?.string, ["uploading", "done", "cancelled", "error"].contains(state) else {
                return "Некорректное состояние передачи"
            }
            guard let loaded = payload["loaded"]?.double, let total = payload["total"]?.double, loaded >= 0, total >= 0, total <= Double(maxFileBytes) else {
                return "Некорректный прогресс"
            }
            return nil
        }
    }

    private static func allowedKey(_ key: String) -> Bool {
        if key.count == 1, let scalar = key.unicodeScalars.first, CharacterSet.alphanumerics.contains(scalar), scalar.isASCII {
            return true
        }
        let named = ["enter", "escape", "tab", "backspace", "space", "up", "down", "left", "right", "ctrl", "alt", "shift", "win", "meta"]
        if named.contains(key) { return true }
        if key.hasPrefix("f"), let number = Int(key.dropFirst()), (1...12).contains(number) { return true }
        return false
    }
}
