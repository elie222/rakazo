package com.rakazo.pdfview

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.graphics.pdf.PdfRenderer
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.os.ParcelFileDescriptor
import android.util.LruCache
import android.view.View
import android.view.ViewGroup
import android.widget.BaseAdapter
import android.widget.ImageView
import android.widget.ListView
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import java.io.File
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * Pages stacked vertically at the view's width. PdfRenderer allows one open page at a time and
 * is not thread-safe, so every page is opened on one background thread.
 */
class RakazoPdfView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  override val shouldUseAndroidLayout = true

  private val onLoadError by EventDispatcher()
  private val main = Handler(Looper.getMainLooper())
  private val worker: ExecutorService = Executors.newSingleThreadExecutor()
  private val gap = (8 * resources.displayMetrics.density).toInt()
  private val pages = ListView(context).apply {
    divider = ColorDrawable(Color.TRANSPARENT)
    dividerHeight = gap
    clipToPadding = false
    setPadding(0, gap, 0, gap)
  }
  // A few screens of pages; each bitmap is the view's width at the page's aspect ratio.
  private val bitmaps = object : LruCache<Int, Bitmap>(
    (Runtime.getRuntime().maxMemory() / 8).toInt().coerceAtLeast(8 * 1024 * 1024),
  ) {
    override fun sizeOf(key: Int, value: Bitmap) = value.byteCount
  }
  private var renderer: PdfRenderer? = null
  private var descriptor: ParcelFileDescriptor? = null
  private var aspect: List<Float> = emptyList()
  private var uri: String? = null
  private var generation = 0

  init {
    addView(pages, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
  }

  fun load(next: String) {
    if (next == uri) return
    uri = next
    val current = ++generation
    pages.adapter = null
    bitmaps.evictAll()
    worker.execute {
      closeDocument()
      val sizes = try {
        val path = Uri.parse(next).path ?: throw IllegalArgumentException("Not a file")
        val fd = ParcelFileDescriptor.open(File(path), ParcelFileDescriptor.MODE_READ_ONLY)
        descriptor = fd
        val opened = PdfRenderer(fd)
        renderer = opened
        (0 until opened.pageCount).map { index ->
          opened.openPage(index).use { page -> page.height.toFloat() / page.width.toFloat() }
        }
      } catch (_: Exception) {
        closeDocument()
        null
      }
      main.post {
        if (current != generation) return@post
        if (sizes == null || sizes.isEmpty()) {
          onLoadError(mapOf())
          return@post
        }
        aspect = sizes
        pages.adapter = PageAdapter()
      }
    }
  }

  fun release() {
    generation += 1
    worker.execute { closeDocument() }
    worker.shutdown()
    bitmaps.evictAll()
  }

  private fun closeDocument() {
    renderer?.close()
    renderer = null
    descriptor?.close()
    descriptor = null
  }

  private fun render(index: Int, width: Int, image: ImageView) {
    val current = generation
    worker.execute {
      val page = renderer ?: return@execute
      if (current != generation || index >= page.pageCount) return@execute
      val bitmap = page.openPage(index).use { opened ->
        val height = (width * aspect[index]).toInt().coerceAtLeast(1)
        Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888).also {
          it.eraseColor(Color.WHITE)
          opened.render(it, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
        }
      }
      main.post {
        if (current != generation) return@post
        bitmaps.put(index, bitmap)
        if (image.tag == index) image.setImageBitmap(bitmap)
      }
    }
  }

  private inner class PageAdapter : BaseAdapter() {
    override fun getCount() = aspect.size

    override fun getItem(position: Int) = position

    override fun getItemId(position: Int) = position.toLong()

    override fun getView(position: Int, convertView: View?, parent: ViewGroup): View {
      val image = (convertView as? ImageView) ?: ImageView(context).apply {
        scaleType = ImageView.ScaleType.FIT_XY
        setBackgroundColor(Color.WHITE)
      }
      val width = parent.width.coerceAtLeast(1)
      image.layoutParams = ViewGroup.LayoutParams(width, (width * aspect[position]).toInt())
      image.tag = position
      val cached = bitmaps.get(position)
      image.setImageBitmap(cached)
      if (cached == null) render(position, width, image)
      return image
    }
  }
}
