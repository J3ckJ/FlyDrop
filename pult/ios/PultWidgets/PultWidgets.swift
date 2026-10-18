import ActivityKit
import SwiftUI
import WidgetKit

@main
struct PultWidgetsBundle: WidgetBundle {
    var body: some Widget {
        ComputerStatusWidget()
        PultLiveActivityWidget()
    }
}

struct ComputerEntry: TimelineEntry {
    let date: Date
    let computers: [WidgetComputer]
}

struct ComputerProvider: TimelineProvider {
    func placeholder(in context: Context) -> ComputerEntry {
        ComputerEntry(date: Date(), computers: WidgetStore.load())
    }

    func getSnapshot(in context: Context, completion: @escaping (ComputerEntry) -> Void) {
        completion(ComputerEntry(date: Date(), computers: WidgetStore.load()))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<ComputerEntry>) -> Void) {
        let entry = ComputerEntry(date: Date(), computers: WidgetStore.load())
        completion(Timeline(entries: [entry], policy: .after(Date().addingTimeInterval(15 * 60))))
    }
}

struct ComputerStatusWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "pult.computers", provider: ComputerProvider()) { entry in
            ComputerWidgetView(entry: entry)
                .containerBackground(.black, for: .widget)
        }
        .configurationDisplayName("Компьютеры")
        .description("Кто в сети, кто спит, заряд MacBook.")
        .supportedFamilies([.accessoryRectangular, .accessoryInline, .systemSmall])
    }
}

struct ComputerWidgetView: View {
    var entry: ComputerEntry
    @Environment(\.widgetFamily) private var family

    var body: some View {
        switch family {
        case .accessoryInline:
            Text(entry.computers.map { "\($0.name) \($0.asleep ? "спит" : "в сети")" }.joined(separator: " · "))
        case .accessoryRectangular:
            VStack(alignment: .leading, spacing: 2) {
                ForEach(entry.computers.prefix(3)) { computer in
                    HStack {
                        Circle().fill(computer.asleep ? Color.orange : Color.green).frame(width: 6, height: 6)
                        Text(computer.name).font(.caption2)
                        Spacer()
                        Text(computer.battery.map { "\($0)%" } ?? computer.detail).font(.caption2)
                    }
                }
            }
        case .systemSmall, .systemMedium, .systemLarge, .systemExtraLarge, .accessoryCircular, .accessoryCorner:
            VStack(alignment: .leading, spacing: 6) {
                Text("Пульт").font(.headline)
                ForEach(entry.computers.prefix(3)) { computer in
                    Text("\(computer.name) · \(computer.asleep ? "спит" : "в сети")")
                        .font(.caption)
                        .foregroundStyle(computer.asleep ? Color.orange : Color.green)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        @unknown default:
            Text("Пульт")
        }
    }
}

struct PultLiveActivityWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: PultActivityAttributes.self) { context in
            VStack(alignment: .leading, spacing: 8) {
                if !context.state.flydropTitle.isEmpty {
                    Text("FlyDrop → \(context.state.flydropHost)").font(.headline)
                    ProgressView(value: Double(context.state.flydropPercent), total: 100)
                    Text("\(context.state.flydropTitle) · \(context.state.flydropPercent) %").font(.caption)
                }
                if !context.state.mediaTitle.isEmpty {
                    HStack {
                        VStack(alignment: .leading) {
                            Text(context.state.mediaTitle).bold()
                            Text("\(context.state.mediaArtist) · \(context.state.mediaHost)").font(.caption)
                        }
                        Spacer()
                        Image(systemName: context.state.mediaPlaying ? "pause.fill" : "play.fill")
                    }
                }
            }
            .padding()
            .activityBackgroundTint(.black)
            .activitySystemActionForegroundColor(.white)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    Text(context.state.flydropTitle.isEmpty ? "Пульт" : "\(context.state.flydropPercent)%")
                        .font(.title2.bold())
                }
                DynamicIslandExpandedRegion(.trailing) {
                    Image(systemName: context.state.mediaPlaying ? "music.note" : "pause")
                }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(alignment: .leading) {
                        if !context.state.flydropTitle.isEmpty {
                            Text("FlyDrop → \(context.state.flydropHost) \(context.state.flydropPercent)%")
                        }
                        if !context.state.mediaTitle.isEmpty {
                            Text("\(context.state.mediaTitle) · \(context.state.mediaArtist)")
                        }
                    }
                    .font(.caption)
                }
            } compactLeading: {
                Text(context.state.flydropTitle.isEmpty ? "♪" : "\(context.state.flydropPercent)%")
            } compactTrailing: {
                Image(systemName: "music.note")
            } minimal: {
                Text(context.state.flydropTitle.isEmpty ? "♪" : "\(context.state.flydropPercent)")
            }
        }
    }
}
