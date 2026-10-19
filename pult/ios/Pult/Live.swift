import ActivityKit
import Foundation

@MainActor
final class ActivityHandle {
    private var activity: Activity<PultActivityAttributes>?

    func update(_ state: PultActivityAttributes.ContentState) {
        let content = ActivityContent(state: state, staleDate: nil)
        if let activity {
            Task { await activity.update(content) }
            return
        }
        activity = try? Activity.request(attributes: PultActivityAttributes(title: "Пульт"), content: content, pushType: nil)
    }
}
