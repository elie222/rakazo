import ExpoModulesCore
import UIKit

public final class RakazoComposerKeyboardModule: Module {
  public func definition() -> ModuleDefinition {
    Name("RakazoComposerKeyboard")

    View(RakazoComposerKeyboardView.self) {
      Events("onHardwareKey")
      Prop("enterEnabled") { (view: RakazoComposerKeyboardView, enabled: Bool) in
        view.enterEnabled = enabled
      }
      Prop("commandEnterEnabled") { (view: RakazoComposerKeyboardView, enabled: Bool) in
        view.commandEnterEnabled = enabled
      }
      Prop("pickerOpen") { (view: RakazoComposerKeyboardView, open: Bool) in
        view.pickerOpen = open
      }
    }
  }
}

final class RakazoComposerKeyboardView: ExpoView {
  let onHardwareKey = EventDispatcher()
  var enterEnabled = false
  var commandEnterEnabled = false
  var pickerOpen = false

  private lazy var commands = [
    command("\r", key: "Enter", action: #selector(handleEnter(_:))),
    command("\r", key: "CommandEnter", action: #selector(handleCommandEnter(_:)), modifiers: .command),
    command(UIKeyCommand.inputUpArrow, key: "ArrowUp", action: #selector(handlePickerKey(_:))),
    command(UIKeyCommand.inputDownArrow, key: "ArrowDown", action: #selector(handlePickerKey(_:))),
    command(UIKeyCommand.inputEscape, key: "Escape", action: #selector(handlePickerKey(_:))),
    command("\t", key: "Tab", action: #selector(handlePickerKey(_:))),
  ]

  private func command(
    _ input: String, key: String, action: Selector, modifiers: UIKeyModifierFlags = []
  ) -> UIKeyCommand {
    let command = UIKeyCommand(
      title: "", action: action, input: input, modifierFlags: modifiers, propertyList: key
    )
    // UITextView otherwise handles Return and arrow keys before this responder.
    command.wantsPriorityOverSystemBehavior = true
    return command
  }

  // UIKit can cache the responder's command list while the text view keeps focus.
  override var keyCommands: [UIKeyCommand]? { commands }

  override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
    switch action {
    case #selector(handleEnter(_:)): return enterEnabled && canHandleKeys
    case #selector(handleCommandEnter(_:)): return commandEnterEnabled && canHandleKeys
    case #selector(handlePickerKey(_:)): return pickerOpen && canHandleKeys
    default: return super.canPerformAction(action, withSender: sender)
    }
  }

  @objc private func handleEnter(_ command: UIKeyCommand) {
    if enterEnabled { dispatch(command) }
  }

  @objc private func handleCommandEnter(_ command: UIKeyCommand) {
    if commandEnterEnabled { dispatch(command) }
  }

  @objc private func handlePickerKey(_ command: UIKeyCommand) {
    if pickerOpen { dispatch(command) }
  }

  private func dispatch(_ command: UIKeyCommand) {
    guard canHandleKeys, let key = command.propertyList as? String else { return }
    onHardwareKey(["key": key])
  }

  private var canHandleKeys: Bool {
    guard let input = focusedInput(in: self) else { return false }
    return input.markedTextRange == nil
  }

  private func focusedInput(in view: UIView) -> UITextView? {
    if let input = view as? UITextView, input.isFirstResponder { return input }
    return view.subviews.lazy.compactMap { self.focusedInput(in: $0) }.first
  }
}
