import ActivityKit
import Foundation

public struct PultActivityAttributes: ActivityAttributes {
    public struct ContentState: Codable, Hashable, Sendable {
        public var flydropTitle: String
        public var flydropPercent: Int
        public var flydropHost: String
        public var mediaTitle: String
        public var mediaArtist: String
        public var mediaPlaying: Bool
        public var mediaHost: String

        public init(flydropTitle: String, flydropPercent: Int, flydropHost: String, mediaTitle: String, mediaArtist: String, mediaPlaying: Bool, mediaHost: String) {
            self.flydropTitle = flydropTitle
            self.flydropPercent = flydropPercent
            self.flydropHost = flydropHost
            self.mediaTitle = mediaTitle
            self.mediaArtist = mediaArtist
            self.mediaPlaying = mediaPlaying
            self.mediaHost = mediaHost
        }
    }

    public var title: String

    public init(title: String) {
        self.title = title
    }
}

public struct WidgetComputer: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var name: String
    public var asleep: Bool
    public var battery: Int?
    public var detail: String

    public init(id: String, name: String, asleep: Bool, battery: Int?, detail: String) {
        self.id = id
        self.name = name
        self.asleep = asleep
        self.battery = battery
        self.detail = detail
    }
}

public enum WidgetStore {
    public static let suite = "group.app.flydrop.pult"
    public static let key = "computers"

    public static func save(_ computers: [WidgetComputer]) {
        let defaults = UserDefaults(suiteName: suite) ?? .standard
        guard let data = try? JSONEncoder().encode(computers) else { return }
        defaults.set(data, forKey: key)
    }

    public static func load() -> [WidgetComputer] {
        let defaults = UserDefaults(suiteName: suite) ?? .standard
        guard let data = defaults.data(forKey: key), let computers = try? JSONDecoder().decode([WidgetComputer].self, from: data) else {
            return [
                WidgetComputer(id: "macbook", name: "MacBook", asleep: false, battery: 82, detail: "в сети"),
                WidgetComputer(id: "win", name: "Windows", asleep: false, battery: nil, detail: "в сети"),
                WidgetComputer(id: "mini", name: "mac-mini", asleep: true, battery: nil, detail: "спит"),
            ]
        }
        return computers
    }
}
