package com.rakazo.pdfview

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/** A PDF drawn with the system PdfRenderer; Android's WebView cannot show one. */
class RakazoPdfViewModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("RakazoPdfView")

    View(RakazoPdfView::class) {
      Events("onLoadError")
      Prop("uri") { view: RakazoPdfView, uri: String -> view.load(uri) }
      OnViewDestroys { view: RakazoPdfView -> view.release() }
    }
  }
}
