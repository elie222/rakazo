import AVFoundation
import SwiftUI

/// What a recording became: words to send, or a reason to type instead.
enum WatchVoiceResult {
  case text(String)
  case typeInstead
}

/// Records one spoken message, then has the iPhone turn it into text.
struct WatchVoiceSheet: View {
  let transcribe: (Data) async throws -> String
  let finish: (WatchVoiceResult) -> Void

  @State private var recorder = WatchRecorder()
  @State private var stage = Stage.recording
  @State private var attempt = 0

  private enum Stage: Equatable {
    case recording, transcribing
    case failed(WatchFailure?)
  }

  var body: some View {
    VStack(spacing: 12) {
      switch stage {
      case .recording:
        Button {
          recorder.stop()
        } label: {
          Image(systemName: "stop.fill")
            .font(.title2)
            .frame(width: 72, height: 72)
            .background(Circle().fill(.red.opacity(0.25 + 0.6 * recorder.level)))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Stop")
      case .transcribing:
        ProgressView()
      case .failed(let failure):
        Text(failure?.label ?? "Didn’t catch that.")
          .multilineTextAlignment(.center)
        // These need the iPhone first, so another recording would fail the same way.
        if failure != .voiceAccount && failure != .consent && failure != .signIn {
          Button("Try Again", systemImage: "mic.fill") { attempt += 1 }
        }
      }
    }
    // Closing the sheet cancels the attempt, so words that arrive later are never sent.
    .task(id: attempt) { await listen() }
    .onDisappear { recorder.cancel() }
  }

  private func listen() async {
    stage = .recording
    let allowed = await AVAudioApplication.requestRecordPermission()
    guard !Task.isCancelled else { return }
    guard allowed else {
      finish(.typeInstead)
      return
    }
    guard let audio = await recorder.record(), !Task.isCancelled else {
      stage = .failed(nil)
      return
    }
    stage = .transcribing
    do {
      let text = try await transcribe(audio).trimmingCharacters(in: .whitespacesAndNewlines)
      guard !Task.isCancelled else { return }
      if text.isEmpty { stage = .failed(nil) } else { finish(.text(text)) }
    } catch WatchFailure.noVoice {
      guard !Task.isCancelled else { return }
      finish(.typeInstead)
    } catch {
      stage = .failed(error as? WatchFailure ?? .voiceFailed)
    }
  }
}

/// Small AAC that stops after a pause in speech, or at a minute.
@MainActor @Observable
final class WatchRecorder {
  private(set) var level = 0.0
  private var recorder: AVAudioRecorder?
  private var stopped = false

  private static let speechLevel: Float = -35
  private static let silenceAfterSpeech: Duration = .milliseconds(1_500)
  private static let waitForSpeech: Duration = .seconds(8)
  private static let longest: TimeInterval = 60

  /// The recording, or nil when it heard no speech or could not record.
  func record() async -> Data? {
    stopped = false
    let file = FileManager.default.temporaryDirectory.appending(path: "watch-voice.m4a")
    defer { try? FileManager.default.removeItem(at: file) }
    let session = AVAudioSession.sharedInstance()
    do {
      try session.setCategory(.record, mode: .default)
      try session.setActive(true)
    } catch {
      return nil
    }
    defer { try? session.setActive(false, options: .notifyOthersOnDeactivation) }
    guard
      let recorder = try? AVAudioRecorder(
        url: file,
        settings: [
          AVFormatIDKey: kAudioFormatMPEG4AAC,
          AVSampleRateKey: 16_000,
          AVNumberOfChannelsKey: 1,
          AVEncoderBitRateKey: 24_000,
        ])
    else { return nil }
    self.recorder = recorder
    recorder.isMeteringEnabled = true
    guard !Task.isCancelled, recorder.record(forDuration: Self.longest) else { return nil }

    let clock = ContinuousClock()
    let start = clock.now
    var heardSpeech = false
    var lastSpeech = start
    while recorder.isRecording, !stopped, !Task.isCancelled {
      try? await Task.sleep(for: .milliseconds(100))
      recorder.updateMeters()
      let power = recorder.averagePower(forChannel: 0)
      level = Double(max(0, min(1, (power + 50) / 50)))
      if power > Self.speechLevel {
        heardSpeech = true
        lastSpeech = clock.now
      }
      if heardSpeech ? clock.now - lastSpeech > Self.silenceAfterSpeech
        : clock.now - start > Self.waitForSpeech
      { break }
    }
    // A tap on Stop keeps quiet speech the level never caught.
    let kept = (heardSpeech || stopped) && self.recorder === recorder && !Task.isCancelled
    recorder.stop()
    self.recorder = nil
    level = 0
    return kept ? try? Data(contentsOf: file) : nil
  }

  /// Ends the recording and keeps what it heard.
  func stop() { stopped = true }

  /// Ends the recording and drops it.
  func cancel() {
    stopped = true
    recorder?.stop()
    recorder = nil
  }
}
