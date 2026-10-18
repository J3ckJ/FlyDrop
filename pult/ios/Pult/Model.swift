import Foundation
import PultProtocol

struct MediaItem: Equatable, Identifiable {
    var id: String { "\(app)-\(title)" }
    var title: String
    var artist: String
    var app: String
    var playing: Bool
    var position: Int
    var duration: Int
}

struct AppItem: Equatable, Identifiable {
    var id: String
    var name: String
    var running: Bool
}

struct PultTask: Equatable, Identifiable {
    var id: String
    var computerId: String
    var kind: String
    var title: String
    var detail: String
    var percent: Int?
}

struct PultNote: Equatable, Identifiable {
    var id: String
    var title: String
    var body: String
    var ok: Bool
}

struct ClipboardItem: Equatable {
    var from: String
    var age: String
    var text: String
}

struct Computer: Identifiable, Equatable {
    var id: String
    var name: String
    var osName: String
    var online: Bool
    var asleep: Bool
    var battery: Int?
    var subtitle: String
    var volume: Int
    var media: MediaItem?
    var apps: [AppItem]
    var mac: String?
    var flydropSoon: Bool
    var live: Bool
    var backup: String?
    var host: String?
    var port: Int?
    var fingerprint: String?
    var flydropCode: String?
    var flydropHostId: String?
    var flydropPort: Int?
}

enum PultTab: String, CaseIterable {
    case computers
    case inbox
    case scenarios

    var title: String {
        switch self {
        case .computers: return "Компьютеры"
        case .inbox: return "Входящие"
        case .scenarios: return "Сценарии"
        }
    }
}

enum PultScreen: Equatable {
    case home
    case control
    case trackpad
    case now
    case media
    case lock
}

enum PultSheet: Equatable {
    case power
    case keyboard
    case volume
}

@MainActor
@Observable
final class AppModel {
    var phase: Phase = .pairing
    var error = ""
    var code = ""
    var host = ""
    var port = PultCodec.defaultPort
    var tab: PultTab = .computers
    var screen: PultScreen = .home
    var sheet: PultSheet?
    var index = 0
    var search = ""
    var computers: [Computer] = []
    var tasks: [PultTask] = []
    var notes: [PultNote] = []
    var clipboard: ClipboardItem?
    var hold: Double = 0
    var warning = ""
    var discovered: [DiscoveredHost] = []
    var activity: ActivityHandle?
    private var clients: [String: AgentClient] = [:]
    private let discovery = Discovery()
    private let mock: Bool

    enum Phase { case pairing, app }

    init() {
        mock = ProcessInfo.processInfo.arguments.contains("-PultMock")
        if mock { openDemo() }
    }

    var current: Computer? {
        computers.indices.contains(index) ? computers[index] : computers.first
    }

    var filtered: [Computer] {
        let query = search.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if query.isEmpty { return computers }
        return computers.filter { "\($0.name) \($0.subtitle)".lowercased().contains(query) }
    }

    func openDemo() {
        computers = [
            Computer(id: "macbook", name: "MacBook Pro", osName: "macos", online: true, asleep: false, battery: 82, subtitle: "Spotify, Xcode · батарея 82 %\nWi-Fi «Home» · 192.168.1.24", volume: 40, media: MediaItem(title: "Teardrop", artist: "Massive Attack", app: "Spotify", playing: true, position: 134, duration: 330), apps: [
                AppItem(id: "Spotify", name: "Spotify", running: true),
                AppItem(id: "Safari", name: "Safari", running: false),
                AppItem(id: "Terminal", name: "Терминал", running: false),
                AppItem(id: "Xcode", name: "Xcode", running: true),
            ], mac: nil, flydropSoon: true, live: false, backup: nil, host: nil, port: nil, fingerprint: nil, flydropCode: nil, flydropHostId: nil, flydropPort: nil),
            Computer(id: "win", name: "Windows ПК", osName: "windows", online: true, asleep: false, battery: nil, subtitle: "в сети · desktop-eugene", volume: 40, media: nil, apps: [], mac: nil, flydropSoon: false, live: true, backup: nil, host: nil, port: nil, fingerprint: nil, flydropCode: nil, flydropHostId: nil, flydropPort: nil),
            Computer(id: "mini", name: "mac-mini", osName: "macos", online: false, asleep: true, subtitle: "спит 3 ч", volume: 0, media: nil, apps: [], mac: "B8:27:EB:00:00:01", flydropSoon: true, live: false, backup: "03:00", host: nil, port: nil, fingerprint: nil, flydropCode: nil, flydropHostId: nil, flydropPort: nil),
        ]
        tasks = [
            PultTask(id: "music", computerId: "macbook", kind: "media", title: "Teardrop", detail: "Massive Attack · Spotify · 2:14", percent: nil),
            PultTask(id: "fly", computerId: "win", kind: "flydrop", title: "IMG_2041.jpg", detail: "FlyDrop → Windows ПК", percent: 64),
        ]
        clipboard = ClipboardItem(from: "MacBook Pro", age: "10 с назад", text: "ssh://git@mac-mini.local:2222/eugene/el-workspace.git")
        notes = [
            PultNote(id: "n1", title: "FlyDrop: фото получено", body: "Windows ПК · сейчас", ok: true),
            PultNote(id: "n2", title: "Xcode: сборка успешна", body: "MacBook Pro · 2 мин", ok: true),
            PultNote(id: "n3", title: "Windows: нужна перезагрузка", body: "Windows ПК · 14 мин", ok: false),
        ]
        phase = .app
        if activity == nil { activity = ActivityHandle() }
        publishWidgets()
        refreshActivity()
    }

    func startDiscovery() {
        discovery.start { [weak self] hosts in
            Task { @MainActor in self?.discovered = hosts }
        }
    }

    func pair() async {
        if mock { openDemo(); return }
        error = ""
        let address = host.trimmingCharacters(in: .whitespaces)
        guard !address.isEmpty, (100_000...999_999).contains(Int(code) ?? 0), code.count == 6 else {
            error = "Нужны адрес компьютера и шесть цифр кода"
            return
        }
        let client = AgentClient(host: address, port: port)
        do {
            try await client.connect()
            let hello = try await client.request(.hello, ["name": .string("iPhone")])
            let fingerprint = hello["fingerprint"]?.string ?? ""
            client.pin(fingerprint)
            let paired = try await client.request(.pair, ["code": .string(code), "name": .string("iPhone")])
            let token = paired["token"]?.string ?? ""
            UserDefaults.standard.set(token, forKey: "pult-token-\(address)")
            UserDefaults.standard.set(fingerprint, forKey: "pult-fp-\(address)")
            adopt(client: client, info: paired, tokenHost: address)
        } catch {
            self.error = error.localizedDescription
            client.close()
        }
    }

    func adopt(client: AgentClient, info: [String: JSON], tokenHost: String) {
        let id = tokenHost
        var computer = Computer(id: id, name: info["name"]?.string ?? tokenHost, osName: info["os"]?.string ?? "", online: true, asleep: false, battery: nil, subtitle: "в сети", volume: 0, media: nil, apps: [], mac: info["mac"]?.string, flydropSoon: (info["os"]?.string ?? "") != "windows", live: true, backup: nil, host: tokenHost, port: port, fingerprint: info["fingerprint"]?.string, flydropCode: info["flydrop"]?.object?["code"]?.string, flydropHostId: info["flydrop"]?.object?["hostId"]?.string, flydropPort: info["flydrop"]?.object?["httpsPort"]?.int)
        if let existing = computers.firstIndex(where: { $0.id == id }) {
            computers[existing] = computer
            index = existing
        } else {
            computers.append(computer)
            index = computers.count - 1
        }
        clients[id] = client
        phase = .app
        client.onEvent { [weak self] type, payload in
            Task { @MainActor in self?.applyEvent(type: type, payload: payload, computerId: id) }
        }
        Task { await refresh(id) }
    }

    func refresh(_ id: String) async {
        guard let client = clients[id], let offset = computers.firstIndex(where: { $0.id == id }) else { return }
        if let status = try? await client.request(.statusGet) {
            computers[offset].volume = status["volume"]?.int ?? computers[offset].volume
            computers[offset].battery = status["battery"]?.int
            computers[offset].asleep = status["asleep"]?.bool ?? false
            computers[offset].online = !(computers[offset].asleep)
            if let media = status["media"]?.object {
                computers[offset].media = MediaItem(title: media["title"]?.string ?? "", artist: media["artist"]?.string ?? "", app: media["app"]?.string ?? "", playing: media["playing"]?.bool ?? false, position: media["position"]?.int ?? 0, duration: media["duration"]?.int ?? 0)
            }
        }
        if let apps = try? await client.request(.appsList) {
            computers[offset].apps = (apps["apps"]?.array ?? []).compactMap { item in
                guard let object = item.object, let appId = object["id"]?.string else { return nil }
                return AppItem(id: appId, name: object["name"]?.string ?? appId, running: object["running"]?.bool ?? false)
            }
        }
        if let clip = try? await client.request(.clipboardGet), let text = clip["text"]?.string, !text.isEmpty {
            clipboard = ClipboardItem(from: computers[offset].name, age: "сейчас", text: text)
        }
        publishWidgets()
    }

    func send(_ type: ClientType, _ payload: [String: JSON], computerId: String? = nil) async -> [String: JSON]? {
        let id = computerId ?? current?.id
        guard let id, let offset = computers.firstIndex(where: { $0.id == id }) else { return nil }
        if clients[id] == nil {
            applyLocal(type, payload, index: offset)
            return [:]
        }
        return try? await clients[id]?.request(type, payload)
    }

    func applyLocal(_ type: ClientType, _ payload: [String: JSON], index: Int) {
        switch type {
        case .mediaCommand:
            guard var media = computers[index].media else { return }
            switch payload["action"]?.string {
            case "toggle": media.playing.toggle()
            case "pause": media.playing = false
            case "play": media.playing = true
            case "next": media.title = "Angel"; media.position = 0
            case "previous": media.position = 0
            default: break
            }
            computers[index].media = media
        case .volumeSet:
            if let level = payload["level"]?.int { computers[index].volume = level }
        case .appsLaunch:
            if let appId = payload["id"]?.string, let appIndex = computers[index].apps.firstIndex(where: { $0.id == appId }) {
                computers[index].apps[appIndex].running = true
            }
        case .powerAction:
            if payload["action"]?.string == "sleep" { computers[index].asleep = true; computers[index].online = false }
            if payload["action"]?.string == "shutdown" && payload["hold"]?.bool == true {
                if tasks.contains(where: { $0.kind == "flydrop" && $0.computerId == computers[index].id }) && payload["force"]?.bool != true {
                    warning = "FlyDrop ещё идёт — выключение подождёт"
                } else {
                    sheet = nil
                }
            }
        case .wolWake:
            computers[index].asleep = false
            computers[index].online = true
            computers[index].subtitle = "в сети"
        case .hello, .pair, .statusGet, .screenSubscribe, .screenUnsubscribe, .inputMove, .inputClick, .inputScroll, .inputKey, .inputText, .appsList, .clipboardGet, .clipboardSet, .notificationsList, .wolScheduleList, .wolSchedulePut, .wolScheduleDelete, .flydropProgress, .flydropInfo:
            break
        }
        publishWidgets()
        refreshActivity()
    }

    func applyEvent(type: String, payload: [String: JSON], computerId: String) {
        switch type {
        case "event.notification":
            notes.insert(PultNote(id: UUID().uuidString, title: payload["title"]?.string ?? "Пульт", body: payload["body"]?.string ?? "", ok: true), at: 0)
        case "event.clipboard":
            clipboard = ClipboardItem(from: computers.first { $0.id == computerId }?.name ?? "Компьютер", age: "сейчас", text: payload["text"]?.string ?? "")
        case "event.flydrop":
            let percent = payload["percent"]?.int ?? 0
            tasks.removeAll { $0.id == "fly" }
            if payload["state"]?.string == "uploading" || payload["active"]?.bool == true {
                tasks.insert(PultTask(id: "fly", computerId: computerId, kind: "flydrop", title: payload["name"]?.string ?? "Файл", detail: "FlyDrop", percent: percent), at: 0)
            }
        case "event.media":
            break
        case "event.wol", "event.screen":
            break
        default:
            break
        }
        refreshActivity()
    }

    func wake(_ computer: Computer) async {
        if let mac = computer.mac {
            _ = await send(.wolWake, ["mac": .string(mac)], computerId: computer.id)
        }
        if let offset = computers.firstIndex(where: { $0.id == computer.id }) {
            computers[offset].asleep = false
            computers[offset].online = true
        }
    }

    func scheduleBackup() async {
        let mini = computers.first { $0.id == "mini" } ?? current
        guard let mini, let mac = mini.mac else { return }
        _ = await send(.wolSchedulePut, ["mac": .string(mac), "label": .string("Бэкап"), "hour": .int(3), "minute": .int(0)], computerId: computers.first { $0.live }?.id ?? mini.id)
    }

    func upload(data: Data, filename: String) async {
        guard let computer = computers.first(where: { $0.live && !$0.flydropSoon }) ?? current else { return }
        if computer.flydropSoon {
            notes.insert(PultNote(id: UUID().uuidString, title: "FlyDrop для Mac — скоро", body: filename, ok: false), at: 0)
            return
        }
        tasks.insert(PultTask(id: "fly", computerId: computer.id, kind: "flydrop", title: filename, detail: "FlyDrop → \(computer.name)", percent: 0), at: 0)
        refreshActivity()
        if let client = clients[computer.id], let port = computer.flydropPort, let code = computer.flydropCode, let hostId = computer.flydropHostId, let host = computer.host {
            do {
                try await FlyDropUpload.send(host: host, port: port, code: code, hostId: hostId, fingerprint: computer.fingerprint ?? "", filename: filename, data: data) { [weak self] percent in
                    Task { @MainActor in
                        self?.tasks.removeAll { $0.id == "fly" }
                        self?.tasks.insert(PultTask(id: "fly", computerId: computer.id, kind: "flydrop", title: filename, detail: "FlyDrop → \(computer.name)", percent: percent), at: 0)
                        self?.refreshActivity()
                    }
                }
                _ = await send(.flydropProgress, ["name": .string(filename), "loaded": .int(data.count), "total": .int(data.count), "state": .string("done")], computerId: computer.id)
            } catch {
                notes.insert(PultNote(id: UUID().uuidString, title: "Передача не удалась", body: error.localizedDescription, ok: false), at: 0)
            }
        } else if mock {
            tasks.removeAll { $0.id == "fly" }
            tasks.insert(PultTask(id: "fly", computerId: computer.id, kind: "flydrop", title: filename, detail: "FlyDrop → \(computer.name)", percent: 64), at: 0)
        }
        refreshActivity()
    }

    func publishWidgets() {
        WidgetStore.save(computers.prefix(3).map { computer in
            WidgetComputer(id: computer.id, name: computer.name, asleep: computer.asleep, battery: computer.battery, detail: computer.asleep ? "спит" : "в сети")
        })
    }

    func refreshActivity() {
        let transfer = tasks.first { $0.kind == "flydrop" }
        let mediaComputer = computers.first { $0.media != nil }
        let state = PultActivityAttributes.ContentState(
            flydropTitle: transfer?.title ?? "",
            flydropPercent: transfer?.percent ?? 0,
            flydropHost: computers.first { $0.id == transfer?.computerId }?.name ?? "",
            mediaTitle: mediaComputer?.media?.title ?? "",
            mediaArtist: mediaComputer?.media?.artist ?? "",
            mediaPlaying: mediaComputer?.media?.playing ?? false,
            mediaHost: mediaComputer?.name ?? ""
        )
        activity?.update(state)
    }

    func runSearch() {
        let command = search.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if command.hasPrefix("разбудить"), let asleep = computers.first(where: { $0.asleep }) {
            Task { await wake(asleep) }
        }
    }
}
