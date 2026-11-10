import ExpoModulesCore
import PDFKit

/** The system PDF viewer, so a PDF reads in the app with zoom and search like Files. */
public final class RakazoPdfViewModule: Module {
  public func definition() -> ModuleDefinition {
    Name("RakazoPdfView")

    View(RakazoPdfView.self) {
      Events("onLoadError")
      Prop("uri") { (view: RakazoPdfView, uri: String) in view.load(uri) }
    }
  }
}

final class RakazoPdfView: ExpoView {
  let onLoadError = EventDispatcher()
  private let pdfView = PDFView()
  private var uri: String?

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    pdfView.autoScales = true
    pdfView.displayMode = .singlePageContinuous
    pdfView.displayDirection = .vertical
    pdfView.backgroundColor = .secondarySystemBackground
    addSubview(pdfView)
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    pdfView.frame = bounds
  }

  func load(_ next: String) {
    guard next != uri else { return }
    uri = next
    guard let url = URL(string: next), url.isFileURL, let document = PDFDocument(url: url) else {
      pdfView.document = nil
      onLoadError([:])
      return
    }
    pdfView.document = document
  }
}
