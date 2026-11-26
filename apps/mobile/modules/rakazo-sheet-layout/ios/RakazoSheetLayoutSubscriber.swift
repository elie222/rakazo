import ExpoModulesCore
import ObjectiveC
import UIKit

public final class RakazoSheetLayoutSubscriber: ExpoAppDelegateSubscriber {
  @MainActor
  public func subscriberDidRegister() {
    if #available(iOS 27.1, *) {
      Self.configureReactNativeSheets()
    }
  }

  @available(iOS 27.1, *)
  @MainActor
  private static func configureReactNativeSheets() {
    // React Native Core ships precompiled. Add the preference on its modal
    // controller only, and defer to React Native if it adds its own override.
    let selector = #selector(getter: UIViewController.preferredVerticalBarBehavior)
    guard let controller = NSClassFromString("RCTFabricModalHostViewController") as? UIViewController.Type,
      let method = class_getInstanceMethod(controller, selector) else { return }

    let preference: @convention(block) (UIViewController) -> Int = { modal in
      switch modal.modalPresentationStyle {
      case .pageSheet, .formSheet:
        return UIVerticalBarBehavior.disabled.rawValue
      default:
        return UIVerticalBarBehavior.automatic.rawValue
      }
    }
    let implementation = imp_implementationWithBlock(preference)
    if !class_addMethod(controller, selector, implementation, method_getTypeEncoding(method)) {
      imp_removeBlock(implementation)
    }
  }
}
