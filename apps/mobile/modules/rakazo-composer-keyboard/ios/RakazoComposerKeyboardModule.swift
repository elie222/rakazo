import ExpoModulesCore
import UIKit

public final class RakazoComposerKeyboardModule: Module {
  public func definition() -> ModuleDefinition {
    Name("RakazoComposerKeyboard")

    View(RakazoComposerKeyboardView.self) {
      Events("onHardwareKey")
      Prop("keys") { (view: RakazoComposerKeyboardView, keys: [String]) in
        view.keys = keys
      }
    }
  }
}

final class RakazoComposerKeyboardView: ExpoView {
  let onHardwareKey = EventDispatcher()
  var keys: [String] = []

  private lazy var commands = [
    "Enter": command("\r", key: "Enter"),
    "CommandEnter": command("\r", key: "CommandEnter", modifiers: .command),
    "ArrowUp": command(UIKeyCommand.inputUpArrow, key: "ArrowUp"),
    "ArrowDown": command(UIKeyCommand.inputDownArrow, key: "ArrowDown"),
    "Escape": command(UIKeyCommand.inputEscape, key: "Escape"),
    "Tab": command("\t", key: "Tab"),
  ]

  private func command(
    _ input: String, key: String, modifiers: UIKeyModifierFlags = []
  ) -> UIKeyCommand {
    let command = UIKeyCommand(
      title: "", action: #selector(handleHardwareKey(_:)), input: input,
      modifierFlags: modifiers, propertyList: key
    )
    // UITextView otherwise handles Return and arrow keys before this responder.
    command.wantsPriorityOverSystemBehavior = true
    return command
  }

  override var keyCommands: [UIKeyCommand]? {
    guard !keys.isEmpty, let input = focusedInput(in: self), input.markedTextRange == nil else {
      return super.keyCommands
    }
    return keys.compactMap { commands[$0] }
  }

  @objc private func handleHardwareKey(_ command: UIKeyCommand) {
    guard let key = command.propertyList as? String, keys.contains(key),
      let input = focusedInput(in: self), input.markedTextRange == nil
    else { return }
    onHardwareKey(["key": key])
  }

  private func focusedInput(in view: UIView) -> UITextView? {
    if let input = view as? UITextView, input.isFirstResponder { return input }
    return view.subviews.lazy.compactMap { self.focusedInput(in: $0) }.first
  }
}
