import ExpoModulesCore
import UIKit

public class RakazoListScrollModule: Module {
  public func definition() -> ModuleDefinition {
    Name("RakazoListScroll")

    // Scrolls the native list inside the view with this tag so its row sits mid-screen, even a
    // row the list has not laid out yet. A SwiftUI list has no scroll-to-row JavaScript API,
    // but it is backed by a collection view, whose single section holds the list's rows in order.
    AsyncFunction("scrollToRow") { (viewTag: Int, row: Int) -> Bool in
      guard let view = self.appContext?.findView(withTag: viewTag, ofType: UIView.self),
        let list = Self.outermostCollectionView(in: view),
        list.numberOfSections > 0,
        row >= 0, row < list.numberOfItems(inSection: 0)
      else { return false }
      list.scrollToItem(
        at: IndexPath(item: row, section: 0), at: .centeredVertically, animated: true)
      return true
    }.runOnQueue(.main)
  }

  // Breadth first, so a list nested inside one of the rows is never taken for the list itself.
  private static func outermostCollectionView(in root: UIView) -> UICollectionView? {
    var queue = [root]
    while !queue.isEmpty {
      let view = queue.removeFirst()
      if let list = view as? UICollectionView { return list }
      queue.append(contentsOf: view.subviews)
    }
    return nil
  }
}
