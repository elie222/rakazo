import ActivityKit
import AVFoundation
import AppIntents
import Speech
import UIKit

/// Press to start talking, press again (or pause) to send it to the bot you talked to last. The
/// speech is transcribed on the device when it supports that; only the text is sent. It is a plain
/// intent so the app's shortcut list (which the Action button reads) can hold it while the app
/// supports iOS 16; the recording conformance below needs iOS 18.
struct RecordVoiceMessageIntent: AppIntent {
  static let title: LocalizedStringResource = "Record Message"
  static let description = IntentDescription(
    "Talk, then pause or press again to send it to the bot you talked to last.")
  // The session it sends with can be read only while the iPhone is unlocked.
  static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication

  @MainActor
  func perform() async throws -> some IntentResult {
    guard #available(iOS 18.0, *) else { throw VoiceMessageError.unavailable }
    let recorder = VoiceMessageRecorder.shared
    // Before deciding, so a second press during the cleanup sees the first one's recording.
    await recorder.clearStaleActivities()
    if recorder.isRecording {
      await recorder.finish()
    } else {
      try recorder.start()
    }
    return .result()
  }
}

// A Live Activity can start from the background only from a Live Activity intent.
@available(iOS 18.0, *)
extension RecordVoiceMessageIntent: AudioRecordingIntent, LiveActivityIntent {}

private typealias Status = VoiceMessageAttributes.ContentState.Status

@available(iOS 18.0, *)
@MainActor
final class VoiceMessageRecorder {
  static let shared = VoiceMessageRecorder()

  private let engine = AVAudioEngine()
  private var request: SFSpeechAudioBufferRecognitionRequest?
  private var task: SFSpeechRecognitionTask?
  private var activity: Activity<VoiceMessageAttributes>?
  private var text = ""
  private var timer: Task<Void, Never>?
  private var started = Date()

  private var staleCleanup: Task<Void, Never>?

  var isRecording: Bool { request != nil }

  /// Ends activities an earlier launch left when iOS closed it mid-recording, once per launch, so
  /// a message from this launch that is still sending keeps its island.
  func clearStaleActivities() async {
    if staleCleanup == nil { staleCleanup = Task { await VoiceMessageAttributes.endAll() } }
    await staleCleanup?.value
  }

  func start() throws {
    // Permission prompts cannot show from the background; the app asks for both on its first call.
    guard AVAudioApplication.shared.recordPermission == .granted,
      SFSpeechRecognizer.authorizationStatus() == .authorized
    else { throw VoiceMessageError.permission }
    guard let recognizer = SFSpeechRecognizer(), recognizer.isAvailable else {
      throw VoiceMessageError.unavailable
    }
    // iOS lets an app start recording in the background only while its Live Activity is running.
    guard ActivityAuthorizationInfo().areActivitiesEnabled else {
      throw VoiceMessageError.liveActivitiesOff
    }
    let activity: Activity<VoiceMessageAttributes>
    do {
      activity = try Activity.request(
        attributes: VoiceMessageAttributes(), content: content(.listening, ""))
    } catch {
      throw VoiceMessageError.failed
    }
    let request = SFSpeechAudioBufferRecognitionRequest()
    request.shouldReportPartialResults = true
    if recognizer.supportsOnDeviceRecognition { request.requiresOnDeviceRecognition = true }
    do {
      let session = AVAudioSession.sharedInstance()
      // Music turns down while listening; a background start cannot pause it. Headphones keep
      // the microphone and the music; without Bluetooth, iOS moves both to the phone.
      try session.setCategory(
        .playAndRecord, mode: .default,
        options: [.duckOthers, .allowBluetoothHFP, .allowBluetoothA2DP])
      try session.setAllowHapticsAndSystemSoundsDuringRecording(true)
      try session.setActive(true)
      let input = engine.inputNode
      // A press while the last message is still sending finds the microphone still held.
      if engine.isRunning { engine.stop() }
      input.removeTap(onBus: 0)
      input.installTap(onBus: 0, bufferSize: 1024, format: input.outputFormat(forBus: 0)) {
        buffer, _ in request.append(buffer)
      }
      engine.prepare()
      try engine.start()
    } catch {
      releaseMicrophone()
      Task { await activity.end(nil, dismissalPolicy: .immediate) }
      throw VoiceMessageError.failed
    }
    // A light tap says listening has started; the Action button needs a hold first. Feedback
    // generators do not play in the background, so this uses the system "peek" haptic.
    AudioServicesPlaySystemSound(1519)

    self.activity = activity
    self.request = request
    text = ""
    started = Date()
    SendVoiceMessageIntent.send = { [weak self] in await self?.finish() }
    CancelVoiceMessageIntent.cancel = { [weak self] in await self?.cancel() }
    task = recognizer.recognitionTask(with: request) { [weak self] result, error in
      let heard = result?.bestTranscription.formattedString
      // A "final" result only marks a pause between sentences; the pause timer decides when to send.
      let failed = error != nil
      Task { @MainActor in self?.heard(heard, failed: failed, for: request) }
    }
    waitForPause(seconds: 8)
  }

  private func heard(
    _ heard: String?, failed: Bool, for request: SFSpeechAudioBufferRecognitionRequest
  ) {
    // A cancelled recording's last callback can land after the next one has started.
    guard self.request === request else { return }
    if let heard, heard != text {
      text = heard
      Task { [activity] in await activity?.update(content(.listening, heard)) }
      waitForPause(seconds: 2.5)
    }
    if failed { Task { await finish(recognizerFailed: true) } }
  }

  /// Sends after a pause in speech, or after a minute at most.
  private func waitForPause(seconds: Double) {
    timer?.cancel()
    let limit = max(0, 60 - Date().timeIntervalSince(started))
    timer = Task { [weak self] in
      try? await Task.sleep(nanoseconds: UInt64(min(seconds, limit) * 1_000_000_000))
      // finish() cancels this timer, so it runs in its own task to keep its waits from ending early.
      if !Task.isCancelled { Task { await self?.finish() } }
    }
  }

  func finish(recognizerFailed: Bool = false) async {
    guard let request, let activity else { return }
    // The rest works on this message's own activity, so a press meanwhile can start the next one.
    stopListening(request)
    // iOS suspends a background app as soon as it stops recording, so the microphone stays open,
    // its audio dropped, until the message is sent; end() releases it.
    let input = engine.inputNode
    input.removeTap(onBus: 0)
    input.installTap(onBus: 0, bufferSize: 1024, format: input.outputFormat(forBus: 0)) { _, _ in }

    let message = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !message.isEmpty else {
      // A recognizer that fails before any words is not the same as silence.
      let reason = recognizerFailed
        ? String(localized: VoiceMessageError.unavailable.localizedStringResource)
        : String(localized: "Nothing heard.")
      return await end(activity, .failed, reason)
    }
    await activity.update(content(.sending, message))
    do {
      try await sendToLastBot(message)
      // The reply arrives as the bot's usual notification, so the island ends here rather than
      // showing it twice.
      await activity.update(content(.thinking, message))
      try? await Task.sleep(nanoseconds: 5_000_000_000)
      await end(activity, .thinking, message, dismissAfter: 0)
    } catch {
      // Says why when the reason is the user's to fix, such as being signed out or offline.
      let reason =
        (error as? CustomLocalizedStringResourceConvertible)
        .map { String(localized: $0.localizedStringResource) }
        ?? (error as? URLError)?.localizedDescription ?? ""
      await end(activity, .failed, reason)
    }
  }

  /// Stops listening and sends nothing.
  func cancel() async {
    guard let request, let activity else { return }
    stopListening(request)
    releaseMicrophone()
    await activity.end(nil, dismissalPolicy: .immediate)
  }

  private func stopListening(_ request: SFSpeechAudioBufferRecognitionRequest) {
    self.request = nil
    activity = nil
    timer?.cancel()
    request.endAudio()
    task?.cancel()
    task = nil
  }

  private func releaseMicrophone() {
    engine.stop()
    engine.inputNode.removeTap(onBus: 0)
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
  }

  private func end(
    _ activity: Activity<VoiceMessageAttributes>, _ status: Status, _ text: String,
    dismissAfter seconds: TimeInterval = 4
  ) async {
    // The island drops an ended activity at once, so a failure shows in the pill first.
    if status == .failed {
      await activity.update(content(status, text))
      try? await Task.sleep(nanoseconds: 4_000_000_000)
    }
    // A newer message may be listening on the microphone by now.
    if !isRecording { releaseMicrophone() }
    await activity.end(
      content(status, text), dismissalPolicy: .after(Date().addingTimeInterval(seconds)))
  }
}

/// No alerts: the activity stays in the pill, since opening the island always vibrates.
private func content(_ status: Status, _ text: String)
  -> ActivityContent<VoiceMessageAttributes.ContentState>
{
  ActivityContent(state: .init(status: status, text: text), staleDate: nil)
}

enum VoiceMessageError: Error, CustomLocalizedStringResourceConvertible {
  case permission
  case unavailable
  case liveActivitiesOff
  case failed

  var localizedStringResource: LocalizedStringResource {
    switch self {
    case .permission: "Start a voice call in Rakazo once to allow the microphone."
    case .unavailable: "Speech recognition isn't available right now."
    case .liveActivitiesOff: "Turn on Live Activities for Rakazo in Settings."
    case .failed: "Couldn't start recording."
    }
  }
}
