import SwiftUI
import UIKit
import UniformTypeIdentifiers

struct RootView: View {
    @Bindable var model: AppModel

    var body: some View {
        ZStack(alignment: .top) {
            Color(red: 0.043, green: 0.047, blue: 0.055).ignoresSafeArea()
            VStack(spacing: 0) {
                if model.phase == .app {
                    if model.screen == .home && model.tab == .computers { search }
                    screen
                    if model.sheet == nil && (model.screen == .home || model.screen == .now) { tabBar }
                } else {
                    PairingView(model: model)
                }
            }
        }
        .onAppear { model.startDiscovery() }
        .sheet(item: sheetBinding) { kind in
            PowerSheet(model: model, kind: kind)
                .presentationDetents([.medium, .large])
                .presentationBackground(.ultraThinMaterial)
        }
    }

    private var sheetBinding: Binding<PultSheet?> {
        Binding(get: { model.sheet }, set: { model.sheet = $0 })
    }

    private var search: some View {
        HStack {
            Image(systemName: "magnifyingglass")
            TextField("Поиск или команда", text: $model.search)
                .textInputAutocapitalization(.never)
                .onSubmit { model.runSearch() }
            Image(systemName: "mic")
        }
        .padding(.horizontal, 16)
        .frame(height: 46)
        .background(.ultraThinMaterial, in: Capsule())
        .padding(.horizontal, 16)
        .padding(.top, 8)
    }

    @ViewBuilder private var screen: some View {
        switch model.screen {
        case .home:
            switch model.tab {
            case .computers: HomeView(model: model)
            case .inbox: InboxView(model: model)
            case .scenarios: ScenariosView(model: model)
            }
        case .control: ControlView(model: model)
        case .trackpad: TrackpadView(model: model)
        case .now: NowView(model: model)
        case .media: MediaView(model: model)
        case .lock: LockView(model: model)
        }
    }

    private var tabBar: some View {
        HStack {
            ForEach(PultTab.allCases, id: \.self) { tab in
                Button { model.tab = tab; model.screen = .home } label: {
                    VStack(spacing: 2) {
                        Image(systemName: icon(tab))
                        Text(tab.title).font(.caption2)
                    }
                    .frame(maxWidth: .infinity, minHeight: 52)
                    .background(model.tab == tab ? Color.white.opacity(0.18) : .clear, in: RoundedRectangle(cornerRadius: 24))
                    .overlay(alignment: .topTrailing) {
                        if tab == .inbox && !model.notes.isEmpty {
                            Text("\(model.notes.count)").font(.caption2.bold()).padding(4).background(Color(red: 1, green: 0.271, blue: 0.227), in: Capsule()).foregroundStyle(.white).offset(x: -16, y: 4)
                        }
                    }
                }
                .buttonStyle(.plain)
            }
        }
        .padding(6)
        .frame(height: 62)
        .background(.ultraThinMaterial, in: Capsule())
        .padding(.horizontal, 20)
        .padding(.bottom, 22)
        .foregroundStyle(.white)
    }

    private func icon(_ tab: PultTab) -> String {
        switch tab {
        case .computers: return "display"
        case .inbox: return "tray"
        case .scenarios: return "bolt"
        }
    }
}

extension PultSheet: Identifiable {
    var id: String {
        switch self {
        case .power: return "power"
        case .keyboard: return "keyboard"
        case .volume: return "volume"
        }
    }
}

struct PairingView: View {
    @Bindable var model: AppModel

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Пульт").font(.largeTitle.bold())
            Text("Введите код с экрана компьютера. Без кода управление закрыто.")
                .foregroundStyle(Color(white: 0.6))
            TextField("Адрес компьютера", text: $model.host)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .padding(12)
                .background(Color(white: 0.12), in: RoundedRectangle(cornerRadius: 14))
            TextField("Код из 6 цифр", text: $model.code)
                .keyboardType(.numberPad)
                .padding(12)
                .background(Color(white: 0.12), in: RoundedRectangle(cornerRadius: 14))
            if !model.discovered.isEmpty {
                ForEach(model.discovered) { host in
                    Button("\(host.name) · \(host.host)") {
                        model.host = host.host
                        model.port = host.port
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(Color(red: 0.04, green: 0.52, blue: 1))
                }
            }
            if !model.error.isEmpty {
                HStack(alignment: .top, spacing: 12) {
                    Circle().fill(Color(red: 1, green: 0.624, blue: 0.039)).frame(width: 9, height: 9).padding(.top, 5)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Не вышло подключить").font(.system(size: 15, weight: .bold))
                        Text(model.error).font(.system(size: 13)).foregroundStyle(Color(white: 0.7))
                    }
                }
                .padding(14)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 24))
            }
            Button("Подключить") { Task { await model.pair() } }
                .buttonStyle(PrimaryButton())
            Button("Открыть демо без компьютера") { model.openDemo() }
                .frame(maxWidth: .infinity)
                .foregroundStyle(Color(white: 0.7))
            Spacer()
        }
        .padding(22)
        .foregroundStyle(.white)
    }
}

struct HomeView: View {
    @Bindable var model: AppModel
    @State private var importer = false

    var body: some View {
        VStack(spacing: 12) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 12) {
                    ForEach(Array(model.filtered.enumerated()), id: \.element.id) { offset, computer in
                        card(computer, offset: offset)
                    }
                }
                .padding(.horizontal, 22)
                .scrollTargetLayout()
            }
            .scrollTargetBehavior(.viewAligned)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack {
                    ForEach(model.tasks) { task in
                        Button { model.screen = .now } label: {
                            Text("\(task.title) · \(task.percent.map { "\($0) %" } ?? task.detail)")
                                .font(.caption)
                                .padding(10)
                                .overlay(RoundedRectangle(cornerRadius: 14).stroke(Color.white.opacity(0.12)))
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal, 16)
            }
            HStack {
                Button("IMG_2041.jpg") { Task { await model.upload(data: Data(count: 48 * 1024), filename: "IMG_2041.jpg") } }
                    .buttonStyle(.plain)
                    .padding(8)
                    .background(Color(white: 0.11), in: RoundedRectangle(cornerRadius: 16))
                Button("Добавить") { importer = true }
                    .buttonStyle(.plain)
                    .padding(8)
                    .background(Color(white: 0.11), in: RoundedRectangle(cornerRadius: 16))
            }
            .font(.caption)
            .padding(.horizontal, 16)
        }
        .fileImporter(isPresented: $importer, allowedContentTypes: [.item], allowsMultipleSelection: false) { result in
            guard case .success(let urls) = result, let url = urls.first else { return }
            guard url.startAccessingSecurityScopedResource() else { return }
            defer { url.stopAccessingSecurityScopedResource() }
            if let data = try? Data(contentsOf: url) {
                Task { await model.upload(data: data, filename: url.lastPathComponent) }
            }
        }
    }

    private func card(_ computer: Computer, offset: Int) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            RoundedRectangle(cornerRadius: 18)
                .fill(LinearGradient(colors: [Color(red: 0.14, green: 0.2, blue: 0.27), Color(red: 0.06, green: 0.08, blue: 0.1)], startPoint: .top, endPoint: .bottom))
                .frame(height: 168)
                .overlay(alignment: .bottomLeading) {
                    if computer.live { Text("экран · 12 кадр/с").font(.caption2).padding(8) }
                }
            HStack(spacing: 6) {
                Circle().fill(computer.asleep ? Color(red: 1, green: 0.62, blue: 0.04) : Color(red: 0.19, green: 0.82, blue: 0.35)).frame(width: 8, height: 8)
                Text(computer.asleep ? "Спит" : "В сети · рядом").font(.caption).foregroundStyle(Color(white: 0.6))
            }
            Text(computer.name).font(.largeTitle.bold())
            Text(computer.subtitle).font(.subheadline).foregroundStyle(Color(white: 0.7))
            Button { model.index = model.computers.firstIndex(where: { $0.id == computer.id }) ?? offset; model.screen = .control } label: {
                Label("Управлять", systemImage: "rectangle.and.hand.point.up.left")
            }
            .buttonStyle(PrimaryButton())
            Spacer(minLength: 0)
        }
        .padding(20)
        .frame(width: 338, height: 520, alignment: .topLeading)
        .background(Color(red: 0.086, green: 0.094, blue: 0.110), in: RoundedRectangle(cornerRadius: 42))
        .containerRelativeFrame(.horizontal, count: 1, spacing: 12, alignment: .center)
    }
}

struct ControlView: View {
    @Bindable var model: AppModel

    var body: some View {
        VStack(spacing: 0) {
            TopBar(title: model.current?.name ?? "", back: .home, model: model)
            preview
            ZStack {
                satellite("keyboard", "Клавиатура", x: 56, y: 70) { model.sheet = .keyboard }
                satellite("speaker.wave.2", "Громкость", x: 337, y: 70) { model.sheet = .volume }
                satellite("square.grid.2x2", "Приложения", x: 56, y: 258) { model.screen = .media }
                satellite("power", "Питание", x: 337, y: 258) { model.sheet = .power }
                Button { model.screen = .trackpad } label: {
                    VStack(spacing: 6) {
                        Image(systemName: "rectangle.and.hand.point.up.left")
                        Text("Управлять").font(.system(size: 16, weight: .bold))
                    }
                    .frame(width: 156, height: 156)
                    .background(Circle().fill(.white))
                    .foregroundStyle(Color(red: 0.043, green: 0.047, blue: 0.055))
                }
                .buttonStyle(.plain)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            nowBar
        }
        .foregroundStyle(.white)
    }

    private var nowBar: some View {
        let volume = model.current?.volume ?? 40
        return HStack(spacing: 12) {
            RoundedRectangle(cornerRadius: 12).fill(LinearGradient(colors: [Color(red: 0.85, green: 0.51, blue: 0.17), Color(red: 0.16, green: 0.36, blue: 0.42)], startPoint: .topLeading, endPoint: .bottomTrailing)).frame(width: 46, height: 46)
            VStack(alignment: .leading, spacing: 7) {
                Text("Громкость \(volume) % · Spotify играет").font(.system(size: 13, weight: .bold))
                Capsule().fill(.white).frame(width: 80, height: 4)
            }
            Spacer()
            Button { Task { await model.send(.mediaCommand, ["action": .string("toggle")]) } } label: {
                Image(systemName: "pause.fill").foregroundStyle(Color(red: 0.043, green: 0.047, blue: 0.055))
                    .frame(width: 44, height: 44)
                    .background(Circle().fill(.white))
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 14)
        .frame(height: 74)
        .background(Color(red: 0.086, green: 0.094, blue: 0.110), in: RoundedRectangle(cornerRadius: 26))
        .padding(.horizontal, 16)
        .padding(.bottom, 34)
    }

    private var preview: some View {
        RoundedRectangle(cornerRadius: 30)
            .fill(Color(red: 0.11, green: 0.2, blue: 0.27))
            .frame(height: 220)
            .overlay(alignment: .topLeading) {
                Text("экран · 12 кадр/с").font(.system(size: 12, weight: .bold))
                    .padding(.horizontal, 9).padding(.vertical, 5)
                    .background(Color.black.opacity(0.45), in: RoundedRectangle(cornerRadius: 12))
                    .padding(14)
            }
            .padding(.horizontal, 16)
    }

    private func satellite(_ symbol: String, _ title: String, x: CGFloat, y: CGFloat, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(spacing: 0) {
                Image(systemName: symbol).frame(width: 62, height: 62).background(.ultraThinMaterial, in: Circle())
                Text(title).font(.system(size: 12, weight: .semibold)).foregroundStyle(Color(white: 0.56)).padding(.top, 6)
            }
        }
        .buttonStyle(.plain)
        .position(x: x, y: y)
    }
}

struct TrackpadView: View {
    @Bindable var model: AppModel
    @State private var last: CGPoint?
    @State private var mods: Set<String> = []

    var body: some View {
        VStack {
            TopBar(title: model.current?.name ?? "", back: .control, model: model)
            Color.clear.contentShape(Rectangle()).gesture(DragGesture(minimumDistance: 0).onChanged { value in
                let previous = last ?? value.location
                let dx = value.location.x - previous.x
                let dy = value.location.y - previous.y
                last = value.location
                if dx != 0 || dy != 0 { Task { await model.send(.inputMove, ["dx": .double(dx), "dy": .double(dy)]) } }
            }.onEnded { _ in
                last = nil
                Task { await model.send(.inputClick, ["button": .string("left"), "count": .int(1)]) }
            })
            HStack {
                ForEach(["Ctrl", "Alt", "Win", "Tab", "Esc"], id: \.self) { key in
                    Button(key) {
                        if mods.contains(key) { mods.remove(key) } else { mods.insert(key) }
                        let name = ["Ctrl": "ctrl", "Alt": "alt", "Win": "win", "Tab": "tab", "Esc": "escape"][key] ?? key
                        Task { await model.send(.inputKey, ["key": .string(name), "down": .bool(mods.contains(key))]) }
                    }
                    .padding(.horizontal, 8)
                    .frame(height: 42)
                    .background(mods.contains(key) ? Color(red: 0.04, green: 0.52, blue: 1).opacity(0.3) : Color(white: 0.12), in: RoundedRectangle(cornerRadius: 12))
                }
            }
            .padding(.bottom, 12)
        }
        .foregroundStyle(.white)
    }
}

struct NowView: View {
    @Bindable var model: AppModel

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                TopBar(title: "Сейчас", back: .home, model: model)
                ForEach(model.tasks) { task in
                    VStack(alignment: .leading) {
                        Text(task.title).font(.headline)
                        Text(task.detail).foregroundStyle(Color(white: 0.6))
                        if let percent = task.percent {
                            ProgressView(value: Double(percent), total: 100).tint(Color(red: 0.04, green: 0.52, blue: 1))
                            Button("Отменить") { model.tasks.removeAll { $0.id == task.id } }
                        }
                    }
                    .padding(12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color(white: 0.09), in: RoundedRectangle(cornerRadius: 18))
                }
                ForEach(model.computers.filter(\.asleep)) { computer in
                    VStack(alignment: .leading) {
                        Text(computer.name).font(.headline)
                        Text("Бэкап в \(computer.backup ?? "03:00") — разбудим сами").foregroundStyle(Color(white: 0.6))
                        Button("Разбудить") { Task { await model.wake(computer) } }
                            .buttonStyle(PrimaryButton())
                    }
                    .padding(12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color(white: 0.09), in: RoundedRectangle(cornerRadius: 18))
                }
            }
            .padding(.horizontal, 16)
        }
        .foregroundStyle(.white)
    }
}

struct MediaView: View {
    @Bindable var model: AppModel

    var body: some View {
        let media = model.current?.media
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                TopBar(title: model.current?.name ?? "", back: .control, model: model)
                RoundedRectangle(cornerRadius: 28).fill(LinearGradient(colors: [Color(red: 0.94, green: 0.64, blue: 0.35), Color(red: 0.42, green: 0.29, blue: 0.6), Color(red: 0.1, green: 0.15, blue: 0.27)], startPoint: .topLeading, endPoint: .bottomTrailing)).frame(height: 280)
                Text(media?.title ?? "Ничего не играет").font(.title.bold())
                Text("\(media?.artist ?? "") · \(media?.app ?? "")").foregroundStyle(Color(white: 0.7))
                HStack(spacing: 28) {
                    Button("⏮") { Task { await model.send(.mediaCommand, ["action": .string("previous")]) } }
                    Button(media?.playing == true ? "❚❚" : "▶") { Task { await model.send(.mediaCommand, ["action": .string("toggle")]) } }
                        .font(.title).frame(width: 74, height: 74).background(Circle().fill(.white)).foregroundStyle(.black)
                    Button("⏭") { Task { await model.send(.mediaCommand, ["action": .string("next")]) } }
                }
                .frame(maxWidth: .infinity)
                .font(.title2)
                Text("Открыть на \(model.current?.name ?? "")").font(.headline)
                LazyVGrid(columns: Array(repeating: GridItem(.flexible()), count: 4)) {
                    ForEach(model.current?.apps ?? []) { app in
                        Button { Task { await model.send(.appsLaunch, ["id": .string(app.id)]) } } label: {
                            VStack {
                                Text(String(app.name.prefix(1))).font(.title2).frame(width: 58, height: 58).background(Color(white: 0.12), in: RoundedRectangle(cornerRadius: 16))
                                    .overlay(alignment: .bottom) { if app.running { Circle().fill(.white).frame(width: 5, height: 5).offset(y: 8) } }
                                Text(app.name).font(.caption2)
                            }
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            .padding(16)
        }
        .foregroundStyle(.white)
    }
}

struct InboxView: View {
    @Bindable var model: AppModel

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text("Входящие").font(.largeTitle.bold())
                Text("буфер и уведомления со всех компьютеров").foregroundStyle(Color(white: 0.55))
                if let clipboard = model.clipboard {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Буфер · \(clipboard.from) · \(clipboard.age)").font(.caption).foregroundStyle(Color(white: 0.6))
                        Text(clipboard.text).font(.system(.body, design: .monospaced))
                        Button("Вставить на iPhone") { UIPasteboard.general.string = clipboard.text }
                            .buttonStyle(PrimaryButton())
                    }
                    .padding(14)
                    .background(Color(white: 0.08), in: RoundedRectangle(cornerRadius: 20))
                }
                ForEach(model.notes) { note in
                    HStack(alignment: .top) {
                        Circle().fill(note.ok ? Color(red: 0.19, green: 0.82, blue: 0.35) : Color(red: 1, green: 0.62, blue: 0.04)).frame(width: 8, height: 8).padding(.top, 6)
                        VStack(alignment: .leading) {
                            Text(note.title).bold()
                            Text(note.body).font(.caption).foregroundStyle(Color(white: 0.6))
                        }
                    }
                }
            }
            .padding(16)
        }
        .foregroundStyle(.white)
    }
}

struct ScenariosView: View {
    @Bindable var model: AppModel

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text("Сценарии").font(.largeTitle.bold())
                VStack(alignment: .leading, spacing: 8) {
                    Text("Бэкап mac-mini").font(.headline)
                    Text("Каждую ночь в 03:00 Пульт шлёт Wake-on-LAN.").foregroundStyle(Color(white: 0.6))
                    Button("Запомнить 03:00") { Task { await model.scheduleBackup() } }.buttonStyle(PrimaryButton())
                }
                .padding(12)
                .background(Color(white: 0.09), in: RoundedRectangle(cornerRadius: 18))
                Button("Экран блокировки") { model.screen = .lock }.buttonStyle(PrimaryButton())
            }
            .padding(16)
        }
        .foregroundStyle(.white)
    }
}

struct LockView: View {
    @Bindable var model: AppModel

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text("Воскресенье, 18 октября").font(.system(size: 18, weight: .semibold)).opacity(0.85)
                Text("21:27").font(.system(size: 96, weight: .bold)).tracking(-3)
                HStack {
                    ForEach(model.computers.prefix(3)) { computer in
                        VStack(alignment: .leading) {
                            Text(computer.name.split(separator: " ").first.map(String.init) ?? computer.name).font(.caption)
                            Text(computer.battery.map { "\($0) %" } ?? (computer.asleep ? "спит" : "в сети"))
                                .bold()
                                .foregroundStyle(computer.asleep ? Color(red: 1, green: 0.62, blue: 0.04) : Color(red: 0.19, green: 0.82, blue: 0.35))
                        }
                        .padding(10)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Color.white.opacity(0.08), in: RoundedRectangle(cornerRadius: 16))
                    }
                }
                if let transfer = model.tasks.first(where: { $0.kind == "flydrop" }) {
                    VStack(alignment: .leading) {
                        Text("FlyDrop → \(model.computers.first { $0.id == transfer.computerId }?.name ?? "")").bold()
                        ProgressView(value: Double(transfer.percent ?? 0), total: 100).tint(Color(red: 0.04, green: 0.52, blue: 1))
                        Text("\(transfer.percent ?? 0) %")
                    }
                    .padding(12)
                    .background(Color.black.opacity(0.45), in: RoundedRectangle(cornerRadius: 22))
                }
                if let media = model.computers.first(where: { $0.media != nil })?.media {
                    VStack(alignment: .leading) {
                        Text(media.title).bold()
                        Text(media.artist).foregroundStyle(Color(white: 0.7))
                        HStack {
                            Button("⏮") { Task { await model.send(.mediaCommand, ["action": .string("previous")]) } }
                            Button(media.playing ? "❚❚" : "▶") { Task { await model.send(.mediaCommand, ["action": .string("toggle")]) } }
                            Button("⏭") { Task { await model.send(.mediaCommand, ["action": .string("next")]) } }
                        }
                    }
                    .padding(12)
                    .background(Color.black.opacity(0.45), in: RoundedRectangle(cornerRadius: 22))
                }
                HStack {
                    Button { model.screen = .home; model.tab = .scenarios } label: {
                        Image(systemName: "bolt.fill").frame(width: 50, height: 50).background(.ultraThinMaterial, in: Circle())
                    }
                    Spacer()
                    Button { model.screen = .trackpad } label: {
                        Image(systemName: "rectangle.and.hand.point.up.left").frame(width: 50, height: 50).background(.ultraThinMaterial, in: Circle())
                    }
                }
                .buttonStyle(.plain)
            }
            .padding(16)
        }
        .foregroundStyle(.white)
        .background(RadialGradient(colors: [Color(red: 0.114, green: 0.165, blue: 0.2), Color(red: 0.043, green: 0.047, blue: 0.055)], center: .top, startRadius: 0, endRadius: 520))
    }
}

struct PowerSheet: View {
    @Bindable var model: AppModel
    var kind: PultSheet
    @State private var holding = false

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Capsule().fill(Color.white.opacity(0.3)).frame(width: 42, height: 5).frame(maxWidth: .infinity)
            switch kind {
            case .power:
                Text("Питание · \(model.current?.name ?? "")").font(.headline)
                if let transfer = model.tasks.first(where: { $0.kind == "flydrop" }) {
                    Text("FlyDrop ещё идёт: \(transfer.percent ?? 0) % — выключение подождёт").foregroundStyle(Color.white.opacity(0.6))
                }
                if !model.warning.isEmpty {
                    HStack(spacing: 8) {
                        Circle().fill(Color(red: 1, green: 0.624, blue: 0.039)).frame(width: 9, height: 9)
                        Text(model.warning).foregroundStyle(Color.white.opacity(0.75))
                    }
                }
                HStack {
                    action("Сон") { Task { await model.send(.powerAction, ["action": .string("sleep")]) } }
                    action("Блокировка") { Task { await model.send(.powerAction, ["action": .string("lock")]) } }
                    action("Перезагрузка") { Task { await model.send(.powerAction, ["action": .string("restart")]) } }
                }
                Text("Удерживайте, чтобы выключить")
                    .frame(maxWidth: .infinity)
                    .frame(height: 64)
                    .background(alignment: .leading) { Color(red: 1, green: 0.27, blue: 0.23).opacity(0.35).frame(maxWidth: holding ? .infinity : 0) }
                    .background(Color(red: 0.16, green: 0.07, blue: 0.08), in: RoundedRectangle(cornerRadius: 18))
                    .foregroundStyle(Color(red: 1, green: 0.27, blue: 0.23))
                    .onLongPressGesture(minimumDuration: 0.9, maximumDistance: 40) {
                        Task { _ = await model.send(.powerAction, ["action": .string("shutdown"), "hold": .bool(true)]) }
                    } onPressingChanged: { holding = $0 }
                ForEach(model.computers.filter(\.asleep)) { computer in
                    HStack {
                        VStack(alignment: .leading) { Text(computer.name).bold(); Text("спит · Wake-on-LAN").font(.caption) }
                        Spacer()
                        Button("Разбудить") { Task { await model.wake(computer) } }
                    }
                }
            case .keyboard:
                let keys = Array("йцукенгшщзхъфывапролджэячсмитьбю ")
                LazyVGrid(columns: Array(repeating: GridItem(.adaptive(minimum: 36)), count: 8)) {
                    ForEach(keys.indices, id: \.self) { index in
                        let key = String(keys[index])
                        Button(key == " " ? "пробел" : key) { Task { await model.send(.inputText, ["text": .string(key)]) } }
                            .frame(height: 42)
                            .frame(maxWidth: .infinity)
                            .background(Color(white: 0.12), in: RoundedRectangle(cornerRadius: 12))
                    }
                }
            case .volume:
                Text("Громкость \(model.current?.volume ?? 0) %").font(.headline)
                Slider(value: Binding(get: { Double(model.current?.volume ?? 0) }, set: { value in
                    if let id = model.current?.id, let offset = model.computers.firstIndex(where: { $0.id == id }) {
                        model.computers[offset].volume = Int(value)
                    }
                }), in: 0...100, step: 1) { editing in
                    if !editing { Task { await model.send(.volumeSet, ["level": .int(model.current?.volume ?? 0)]) } }
                }
            }
        }
        .padding(16)
        .foregroundStyle(.white)
    }

    private func action(_ title: String, _ run: @escaping () -> Void) -> some View {
        Button(title, action: run)
            .frame(maxWidth: .infinity, minHeight: 74)
            .background(Color(white: 0.12), in: RoundedRectangle(cornerRadius: 18))
    }
}

struct PrimaryButton: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.headline)
            .frame(maxWidth: .infinity, minHeight: 60)
            .background(Color.white, in: Capsule())
            .foregroundStyle(.black)
            .opacity(configuration.isPressed ? 0.8 : 1)
    }
}

private struct TopBar: View {
    var title: String
    var back: PultScreen
    var model: AppModel

    var body: some View {
        HStack {
            Button("←") { model.screen = back; model.sheet = nil }
                .frame(width: 36, height: 36)
                .background(.ultraThinMaterial, in: Circle())
            Text(title).bold()
            Spacer()
        }
        .padding(.horizontal, 16)
    }
}
