import ExpoModulesCore
import UIKit

// The display link observes geometry even when folding changes no safe-area inset or bounds.
private final class FoldObserver: NSObject {
  var onFrame: (() -> Void)?
  weak var displayLink: CADisplayLink?
  @objc func frame() { onFrame?() }
  @objc func resume() { displayLink?.isPaused = false }
  @objc func pause() { displayLink?.isPaused = true }
}

public final class RakazoFoldRegionsModule: Module {
  private var displayLink: CADisplayLink?
  private var observer: FoldObserver?
  private var previous: [CGRect] = []

  deinit { displayLink?.invalidate() }

  public func definition() -> ModuleDefinition {
    Name("RakazoFoldRegions")
    Events("onChange")

    AsyncFunction("getRegions") { () -> [[String: Double]] in
      MainActor.assumeIsolated { self.payload(self.regions()) }
    }.runOnQueue(.main)

    OnStartObserving {
      DispatchQueue.main.async { [weak self] in self?.start() }
    }
    OnStopObserving {
      DispatchQueue.main.async { [weak self] in self?.stop() }
    }
    OnDestroy {
      DispatchQueue.main.async { [weak self] in self?.stop() }
    }
  }

  @MainActor private func regions() -> [CGRect] {
    if #available(iOS 27.1, *) {
      // Query the key window so frames are already in window coordinates.
      guard let window = appContext?.utilities?.currentViewController()?.view.window,
            window.isKeyWindow else { return [] }
      return window.reservedRegions(kind: .division).filter(\.isActive).map(\.frame)
    }
    return []
  }

  private func payload(_ frames: [CGRect]) -> [[String: Double]] {
    frames.map { ["x": Double($0.minX), "y": Double($0.minY),
                  "width": Double($0.width), "height": Double($0.height)] }
  }

  @MainActor private func start() {
    stop()
    previous = regions()
    sendEvent("onChange", ["regions": payload(previous)])
    if #available(iOS 27.1, *) {
      let observer = FoldObserver()
      observer.onFrame = { [weak self] in
        guard let self else { return }
        let next = self.regions()
        guard next != self.previous else { return }
        self.previous = next
        self.sendEvent("onChange", ["regions": self.payload(next)])
      }
      let link = CADisplayLink(target: observer, selector: #selector(FoldObserver.frame))
      link.preferredFrameRateRange = CAFrameRateRange(minimum: 4, maximum: 15, preferred: 10)
      link.isPaused = UIApplication.shared.applicationState != .active
      observer.displayLink = link
      NotificationCenter.default.addObserver(observer, selector: #selector(FoldObserver.resume),
                                             name: UIApplication.didBecomeActiveNotification, object: nil)
      NotificationCenter.default.addObserver(observer, selector: #selector(FoldObserver.pause),
                                             name: UIApplication.willResignActiveNotification, object: nil)
      link.add(to: .main, forMode: .common)
      self.observer = observer
      displayLink = link
    }
  }

  @MainActor private func stop() {
    if let observer { NotificationCenter.default.removeObserver(observer) }
    displayLink?.invalidate()
    displayLink = nil
    observer = nil
  }
}
