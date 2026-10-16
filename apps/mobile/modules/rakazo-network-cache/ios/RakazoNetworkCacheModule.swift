import ExpoModulesCore

public class RakazoNetworkCacheModule: Module {
  public func definition() -> ModuleDefinition {
    Name("RakazoNetworkCache")

    OnCreate {
      // Cookie deletions can be lost if the app is killed before they reach disk, so repeat
      // them on every launch; the app never uses cookies.
      clearCookies()
      // Builds before no-store replies left account and chat responses in the system cache.
      let key = "rakazo.networkCacheCleared"
      if !UserDefaults.standard.bool(forKey: key) {
        URLCache.shared.removeAllCachedResponses()
        UserDefaults.standard.set(true, forKey: key)
      }
    }

    Function("clear") {
      URLCache.shared.removeAllCachedResponses()
      clearCookies()
    }
  }

  // The app authenticates with its stored token and never needs these back.
  private func clearCookies() {
    let storage = HTTPCookieStorage.shared
    storage.cookies?.forEach(storage.deleteCookie)
  }
}
