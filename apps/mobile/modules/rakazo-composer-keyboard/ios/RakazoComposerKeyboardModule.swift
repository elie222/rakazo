import ExpoModulesCore
import UIKit

public final class RakazoComposerKeyboardModule: Module {
  public func definition() -> ModuleDefinition {
    Name("RakazoComposerKeyboard")

    View(RakazoComposerKeyboardView.self) {
      Events("onHardwareEnter")
      Prop("enabled") { (view: RakazoComposerKeyboardView, enabled: Bool) in
        view.enabled = enabled
      }
    }
  }
}

final class RakazoComposerKeyboardView: ExpoView {
  let onHardwareEnter = EventDispatcher()
  var enabled = false

  private lazy var sendCommand: UIKeyCommand = {
    let command = UIKeyCommand(input: "\r", modifierFlags: [], action: #selector(handleComposerHardwareEnter))
    // UITextView would otherwise handle Return as a newline before this responder.
    command.wantsPriorityOverSystemBehavior = true
    return command
  }()

  override var keyCommands: [UIKeyCommand]? {
    guard enabled, let input = focusedInput(in: self), input.markedTextRange == nil else {
      return super.keyCommands
    }
    return [sendCommand]
  }

  @objc private func handleComposerHardwareEnter() {
    onHardwareEnter([:])
  }

  private func focusedInput(in view: UIView) -> UITextView? {
    if let input = view as? UITextView, input.isFirstResponder { return input }
    return view.subviews.lazy.compactMap { self.focusedInput(in: $0) }.first
  }
}
