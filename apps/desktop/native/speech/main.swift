// System speech recognition for desktop dictation on macOS: Electron's Web Speech has no
// recognition service, so the main process runs this helper instead of asking for a key.
//
//   rakazo-speech <language>
//
// One JSON object per stdout line, shaped after Web Speech so the page treats both alike:
//   {"type":"result","text":"…"}                 the whole session's text so far
//   {"type":"error","error":"not-allowed"}       a Web Speech error code
//   {"type":"end"}                               always last
// A "stop" line on stdin ends the utterance and delivers its final text; closing stdin cancels.

import AVFoundation
import Foundation
import Speech

setvbuf(stdout, nil, _IOLBF, 0)

/// After "stop" the recognizer still owes a final result; never wait on it forever.
let finalResultTimeout: TimeInterval = 4

func emit(_ event: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: event),
    let line = String(data: data, encoding: .utf8)
  else { return }
  print(line)
}

func end(error: String? = nil) -> Never {
  if let error { emit(["type": "error", "error": error]) }
  emit(["type": "end"])
  exit(0)
}

func languageOf(_ identifier: String) -> String {
  identifier.replacingOccurrences(of: "_", with: "-").split(separator: "-").first.map {
    $0.lowercased()
  } ?? ""
}

func tag(_ locale: Locale) -> String {
  locale.identifier.replacingOccurrences(of: "_", with: "-").lowercased()
}

/// The page asks for its UI or browser language (`es-419`, `pt`), which the recognizer may not
/// list. Fall back to the Mac's own region for that language, then to any region of it.
func recognizer(for identifier: String) -> SFSpeechRecognizer? {
  let supported = SFSpeechRecognizer.supportedLocales()
  let wanted = identifier.replacingOccurrences(of: "_", with: "-").lowercased()
  let language = languageOf(identifier)
  let system = tag(Locale.current)
  let match =
    supported.first { tag($0) == wanted }
    ?? supported.first { tag($0) == system && languageOf(system) == language }
    ?? supported.sorted { tag($0) < tag($1) }.first { languageOf($0.identifier) == language }
  return match.flatMap { SFSpeechRecognizer(locale: $0) }
}

func authorizeSpeech(_ done: @escaping (Bool) -> Void) {
  switch SFSpeechRecognizer.authorizationStatus() {
  case .authorized: done(true)
  case .notDetermined: SFSpeechRecognizer.requestAuthorization { done($0 == .authorized) }
  default: done(false)
  }
}

func authorizeMicrophone(_ done: @escaping (Bool) -> Void) {
  switch AVCaptureDevice.authorizationStatus(for: .audio) {
  case .authorized: done(true)
  case .notDetermined: AVCaptureDevice.requestAccess(for: .audio, completionHandler: done)
  default: done(false)
  }
}

/// Recognizer failures as Web Speech codes. Anything unrecognised means the service could not
/// run, which lets the page move to server transcription when one is connected.
func webSpeechCode(_ error: Error) -> String {
  let error = error as NSError
  switch (error.domain, error.code) {
  case ("kAFAssistantErrorDomain", 1110): return "no-speech"
  case ("kAFAssistantErrorDomain", 216), ("kAFAssistantErrorDomain", 209),
    ("kLSRErrorDomain", 301):
    return "aborted"
  case ("kAFAssistantErrorDomain", 1700), ("kLSRErrorDomain", 201):
    return "service-not-allowed"
  default:
    FileHandle.standardError.write(Data("\(error.domain) \(error.code)\n".utf8))
    return "network"
  }
}

final class Session {
  private let engine = AVAudioEngine()
  private let request = SFSpeechAudioBufferRecognitionRequest()
  private var task: SFSpeechRecognitionTask?
  /// Text of the utterances macOS has closed, and where the last one ends in the audio.
  private var kept = ""
  private var keptUntil: TimeInterval = 0

  /// After a pause macOS closes the utterance (that result carries metadata and real timings)
  /// and the next results start over with only the new words, so keep the closed ones in front.
  private func report(_ result: SFSpeechRecognitionResult) {
    let segments = result.bestTranscription.segments
    let text = result.bestTranscription.formattedString
    let closes = result.speechRecognitionMetadata != nil
    // The final result after "stop" repeats an utterance already kept.
    let repeated = closes && (segments.first?.timestamp ?? 0) < keptUntil
    let whole: String
    if repeated {
      whole = kept
    } else if kept.isEmpty || text.hasPrefix(kept) {
      // Older systems keep the whole session in every result.
      whole = text
    } else {
      whole = text.isEmpty ? kept : "\(kept) \(text)"
    }
    emit(["type": "result", "text": whole])
    if closes, !repeated, let last = segments.last {
      kept = whole
      keptUntil = last.timestamp + last.duration
    }
    if result.isFinal { end() }
  }

  func start(_ speech: SFSpeechRecognizer) {
    request.shouldReportPartialResults = true
    // On-device keeps the audio on this Mac; languages without a local model use Apple's service.
    if speech.supportsOnDeviceRecognition { request.requiresOnDeviceRecognition = true }
    if #available(macOS 13, *) { request.addsPunctuation = true }
    let input = engine.inputNode
    let format = input.outputFormat(forBus: 0)
    guard format.sampleRate > 0, format.channelCount > 0 else { end(error: "audio-capture") }
    input.installTap(onBus: 0, bufferSize: 1024, format: format) { [request] buffer, _ in
      request.append(buffer)
    }
    engine.prepare()
    do {
      try engine.start()
    } catch {
      end(error: "audio-capture")
    }
    task = speech.recognitionTask(with: request) { [self] result, error in
      DispatchQueue.main.async {
        if let result { self.report(result) }
        if let error { end(error: webSpeechCode(error)) }
      }
    }
  }

  func stop() {
    engine.stop()
    engine.inputNode.removeTap(onBus: 0)
    request.endAudio()
    DispatchQueue.main.asyncAfter(deadline: .now() + finalResultTimeout) { end() }
  }

  func cancel() -> Never {
    task?.cancel()
    exit(0)
  }
}

let arguments = CommandLine.arguments
guard arguments.count == 2, let speech = recognizer(for: arguments[1]) else {
  end(error: "language-not-supported")
}
guard speech.isAvailable else { end(error: "service-not-allowed") }

let session = Session()
Thread.detachNewThread {
  while let line = readLine() {
    if line == "stop" { DispatchQueue.main.async { session.stop() } }
  }
  DispatchQueue.main.async { session.cancel() }
}
authorizeSpeech { speechAllowed in
  guard speechAllowed else { end(error: "not-allowed") }
  authorizeMicrophone { microphoneAllowed in
    guard microphoneAllowed else { end(error: "not-allowed") }
    DispatchQueue.main.async { session.start(speech) }
  }
}
dispatchMain()
