import EventKit
import ExpoModulesCore
import Foundation
import UIKit

private enum CalendarError: Error {
  case inactive, permission, target, date, identifier
}

private struct Target: Record {
  @Field var accountId: String
  @Field var calendarId: String
}

private struct Timing: Record {
  @Field var allDay: Bool
  @Field var start: String
  @Field var end: String
  @Field var timeZone: String
}

private struct Recurrence: Record {
  @Field var frequency: String
  @Field var interval: Int
  @Field var count: Int?
}

private struct Draft: Record {
  @Field var title: String
  @Field var timing: Timing
  @Field var location: String?
  @Field var notes: String?
  @Field var recurrence: Recurrence?
}

private struct Due: Record {
  @Field var at: String
  @Field var timeZone: String
}

public final class RakazoCalendarModule: Module {
  private let store = EKEventStore()

  public func definition() -> ModuleDefinition {
    Name("RakazoCalendar")

    AsyncFunction("calendars") { (reminders: Bool) -> [[String: Any]] in
      let type: EKEntityType = reminders ? .reminder : .event
      try self.requireAccess(type)
      return self.store.calendars(for: type).map(self.calendarInfo)
    }.runOnQueue(.main)

    AsyncFunction("events") { (target: Target, from: String, to: String) -> [[String: Any]] in
      let calendar = try self.target(target, type: .event)
      let start = try self.instant(from)
      let end = try self.instant(to)
      let predicate = self.store.predicateForEvents(withStart: start, end: end, calendars: [calendar])
      let events = self.store.events(matching: predicate).filter { $0.status != .canceled }
        .sorted { $0.startDate < $1.startDate }
      return Array(events.prefix(101)).map(self.eventInfo)
    }.runOnQueue(.main)

    AsyncFunction("createEvent") { (target: Target, draft: Draft) -> String in
      let calendar = try self.target(target, type: .event, writable: true)
      guard let zone = TimeZone(identifier: draft.timing.timeZone) else { throw CalendarError.date }
      let event = EKEvent(eventStore: self.store)
      event.calendar = calendar
      event.title = draft.title
      event.location = draft.location
      event.notes = draft.notes
      event.timeZone = zone
      event.isAllDay = draft.timing.allDay
      event.startDate = try self.eventDate(draft.timing.start, timing: draft.timing, zone: zone)
      event.endDate = try self.eventDate(draft.timing.end, timing: draft.timing, zone: zone)
      if let rule = draft.recurrence {
        let frequency: EKRecurrenceFrequency
        switch rule.frequency {
        case "daily": frequency = .daily
        case "weekly": frequency = .weekly
        default: throw CalendarError.date
        }
        let end = rule.count.map { EKRecurrenceEnd(occurrenceCount: $0) }
        event.recurrenceRules = [EKRecurrenceRule(recurrenceWith: frequency, interval: rule.interval, end: end)]
      }
      try self.store.save(event, span: .thisEvent, commit: true)
      return event.calendarItemIdentifier
    }.runOnQueue(.main)

    AsyncFunction("reminders") { (target: Target, promise: Promise) in
      do {
        let list = try self.target(target, type: .reminder)
        let predicate = self.store.predicateForIncompleteReminders(withDueDateStarting: nil, ending: nil, calendars: [list])
        self.store.fetchReminders(matching: predicate) { reminders in
          guard let reminders else {
            promise.reject(CalendarError.target)
            return
          }
          promise.resolve(Array(reminders.prefix(101)).map(self.reminderInfo))
        }
      } catch {
        promise.reject(error)
      }
    }.runOnQueue(.main)

    AsyncFunction("createReminder") { (target: Target, title: String, notes: String?, due: Due?) -> String in
      let list = try self.target(target, type: .reminder, writable: true)
      let reminder = EKReminder(eventStore: self.store)
      reminder.calendar = list
      reminder.title = title
      reminder.notes = notes
      if let due {
        guard let zone = TimeZone(identifier: due.timeZone) else { throw CalendarError.date }
        let date = try self.instant(due.at)
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        var components = calendar.dateComponents([.year, .month, .day, .hour, .minute, .second, .nanosecond], from: date)
        components.timeZone = zone
        guard let reconstructed = calendar.date(from: components),
          abs(reconstructed.timeIntervalSince(date)) < 0.000_001 else { throw CalendarError.date }
        reminder.dueDateComponents = components
      }
      try self.store.save(reminder, commit: true)
      return reminder.calendarItemIdentifier
    }.runOnQueue(.main)

    AsyncFunction("completeReminder") { (target: Target, id: String) -> String in
      let list = try self.target(target, type: .reminder, writable: true)
      guard let reminder = self.store.calendarItem(withIdentifier: id) as? EKReminder,
        reminder.calendar.calendarIdentifier == list.calendarIdentifier else { throw CalendarError.identifier }
      if !reminder.isCompleted {
        reminder.isCompleted = true
        try self.store.save(reminder, commit: true)
      }
      return reminder.calendarItemIdentifier
    }.runOnQueue(.main)
  }

  private func requireAccess(_ type: EKEntityType) throws {
    guard UIApplication.shared.applicationState == .active else { throw CalendarError.inactive }
    let status = EKEventStore.authorizationStatus(for: type)
    if #available(iOS 17.0, *) {
      guard status == .fullAccess else { throw CalendarError.permission }
    } else {
      guard status == .authorized else { throw CalendarError.permission }
    }
  }

  private func target(_ target: Target, type: EKEntityType, writable: Bool = false) throws -> EKCalendar {
    try requireAccess(type)
    guard let calendar = store.calendar(withIdentifier: target.calendarId),
      calendar.source.sourceIdentifier == target.accountId,
      calendar.allowedEntityTypes.contains(type == .event ? .event : .reminder),
      !writable || calendar.allowsContentModifications else { throw CalendarError.target }
    return calendar
  }

  private func calendarInfo(_ calendar: EKCalendar) -> [String: Any] {
    [
      "accountId": calendar.source.sourceIdentifier,
      "calendarId": calendar.calendarIdentifier,
      "accountName": calendar.source.title,
      "name": calendar.title,
      "writable": calendar.allowsContentModifications,
      "source": "device"
    ]
  }

  private func eventInfo(_ event: EKEvent) -> [String: Any] {
    let zone = event.timeZone ?? .current
    let date: (Date) -> String = event.isAllDay
      ? { self.day($0, zone: zone) }
      : { ISO8601DateFormatter().string(from: $0) }
    var item: [String: Any] = [
      "id": event.calendarItemIdentifier,
      "title": event.title ?? "",
      "start": date(event.startDate),
      "end": date(event.isAllDay ? exclusiveDayEnd(event, zone: zone) : event.endDate),
      "allDay": event.isAllDay,
    ]
    if let timeZone = event.timeZone { item["timeZone"] = timeZone.identifier }
    if event.hasRecurrenceRules || event.isDetached {
      var recurrence: [String: Any] = [
        "seriesId": event.calendarItemExternalIdentifier ?? event.calendarItemIdentifier,
        "exception": event.isDetached
      ]
      if let originalStart = event.occurrenceDate { recurrence["originalStart"] = date(originalStart) }
      item["recurrence"] = recurrence
    }
    return item
  }

  private func exclusiveDayEnd(_ event: EKEvent, zone: TimeZone) -> Date {
    // EventKit round-trips exclusive midnight, but existing events can end within their last day.
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = zone
    let endDay = calendar.startOfDay(for: event.endDate)
    if event.endDate == endDay && endDay > calendar.startOfDay(for: event.startDate) {
      return endDay
    }
    return calendar.dateInterval(of: .day, for: event.endDate)?.end ?? event.endDate
  }

  private func reminderInfo(_ reminder: EKReminder) -> [String: Any] {
    var item: [String: Any] = ["id": reminder.calendarItemIdentifier, "title": reminder.title ?? ""]
    if let components = reminder.dueDateComponents {
      var calendar = components.calendar ?? Calendar(identifier: .gregorian)
      calendar.timeZone = components.timeZone ?? .current
      if let date = calendar.date(from: components) {
        item["due"] = components.hour == nil
          ? day(date, zone: calendar.timeZone)
          : ISO8601DateFormatter().string(from: date)
        item["timeZone"] = components.timeZone?.identifier
      }
    }
    return item
  }

  private func instant(_ value: String) throws -> Date {
    let formatter = ISO8601DateFormatter()
    if let date = formatter.date(from: value) { return date }
    formatter.formatOptions.insert(.withFractionalSeconds)
    guard let date = formatter.date(from: value) else { throw CalendarError.date }
    return date
  }

  private func day(_ date: Date, zone: TimeZone) -> String {
    let formatter = DateFormatter()
    formatter.calendar = Calendar(identifier: .gregorian)
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.timeZone = zone
    formatter.dateFormat = "yyyy-MM-dd"
    return formatter.string(from: date)
  }

  private func eventDate(_ value: String, timing: Timing, zone: TimeZone) throws -> Date {
    guard timing.allDay else { return try instant(value) }
    let formatter = DateFormatter()
    formatter.calendar = Calendar(identifier: .gregorian)
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.timeZone = zone
    formatter.dateFormat = "yyyy-MM-dd"
    guard let date = formatter.date(from: value), formatter.string(from: date) == value else { throw CalendarError.date }
    return date
  }
}
