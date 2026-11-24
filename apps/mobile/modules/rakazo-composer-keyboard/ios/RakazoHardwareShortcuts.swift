import ObjectiveC
import UIKit

@MainActor
enum RakazoHardwareShortcuts {
  static var stopsThread = false
  static var dispatch: ((String, Bool) -> Void)?

  static let install: Void = {
    let selector = #selector(UIWindow.sendEvent(_:))
    guard let method = class_getInstanceMethod(UIWindow.self, selector) else { return }
    typealias SendEvent = @convention(c) (UIWindow, Selector, UIEvent) -> Void
    let original = unsafeBitCast(method_getImplementation(method), to: SendEvent.self)
    let wrapper: @convention(block) (UIWindow, UIEvent) -> Void = { window, event in
      if !handle(event, in: window) {
        original(window, selector, event)
      }
    }
    class_replaceMethod(
      UIWindow.self, selector, imp_implementationWithBlock(wrapper), method_getTypeEncoding(method))
  }()

  private static func handle(_ event: UIEvent, in window: UIWindow) -> Bool {
    guard let dispatch, window.isKeyWindow, let event = event as? UIPressesEvent else {
      return false
    }
    let pressed = event.allPresses.filter { $0.phase == .began }
    guard pressed.count == 1, let key = pressed.first?.key else { return false }

    let modifiers = key.modifierFlags.intersection([.command, .control, .shift, .alternate])
    let presented = topPresentation(from: window.rootViewController)
    if modifiers == [], key.keyCode == .keyboardEscape {
      let focused = firstResponder(in: window)
      if let input = focused as? UITextInput, input.markedTextRange != nil { return false }
      if let presented {
        if let modal = NSClassFromString("RCTFabricModalHostViewController"),
          presented.isKind(of: modal), let controller = presented.presentationController,
          let requestClose = controller.delegate?.presentationControllerDidAttemptToDismiss
        {
          // React Native uses this delegate callback to emit the Modal's onRequestClose.
          requestClose(controller)
          return true
        }
        // UIKit owns alerts, pickers, and other presentations outside the app's navigator.
        guard let screen = NSClassFromString("RNSScreen"), presented.isKind(of: screen) else {
          return false
        }
      } else {
        guard stopsThread else { return false }
        if let focused, focused is UITextInput {
          let composer = sequence(first: focused, next: { $0.superview })
            .lazy.compactMap { $0 as? RakazoComposerKeyboardView }.first
          guard let composer, !composer.handlesEscape else { return false }
        }
      }
      dispatch("Escape", presented != nil)
      return true
    }

    let character = key.charactersIgnoringModifiers.lowercased()
    guard modifiers == .command, character == "k" || character == "n",
      presented == nil || NSClassFromString("RNSScreen").map({ presented?.isKind(of: $0) == true }) == true
    else { return false }
    dispatch(character, presented != nil)
    return true
  }

  private static func topPresentation(from root: UIViewController?) -> UIViewController? {
    var top = root?.presentedViewController
    while let next = top?.presentedViewController { top = next }
    return top
  }

  private static func firstResponder(in view: UIView) -> UIView? {
    if view.isFirstResponder { return view }
    return view.subviews.lazy.compactMap { firstResponder(in: $0) }.first
  }
}
