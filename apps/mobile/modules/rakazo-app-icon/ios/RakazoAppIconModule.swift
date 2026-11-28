import ExpoModulesCore
import UIKit

public final class RakazoAppIconModule: Module {
  public func definition() -> ModuleDefinition {
    Name("RakazoAppIcon")

    AsyncFunction("supported") { () -> Bool in
      UIApplication.shared.supportsAlternateIcons
    }.runOnQueue(.main)

    // Nil while the app shows its primary icon.
    AsyncFunction("current") { () -> String? in
      UIApplication.shared.alternateIconName
    }.runOnQueue(.main)

    AsyncFunction("set") { (name: String?, promise: Promise) in
      UIApplication.shared.setAlternateIconName(name) { error in
        if let error {
          promise.reject(error)
        } else {
          promise.resolve(nil)
        }
      }
    }.runOnQueue(.main)
  }
}
