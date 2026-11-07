package com.rakazo.pdfview

import android.animation.Animator
import android.animation.AnimatorListenerAdapter
import android.animation.ValueAnimator
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.drawable.BitmapDrawable
import android.graphics.drawable.ColorDrawable
import android.graphics.pdf.PdfRenderer
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.os.ParcelFileDescriptor
import android.util.LruCache
import android.view.GestureDetector
import android.view.MotionEvent
import android.view.ScaleGestureDetector
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
 *
 * Zoom scales the whole list from its top-left corner: the list keeps scrolling vertically in its
 * own coordinates (so recycling still only lays out what is on screen), this view pans it
 * horizontally, and pages redraw at the zoomed width once a gesture settles.
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
    pivotX = 0f
    pivotY = 0f
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
  // Read on the worker too, so a render for a document or width already left never starts.
  @Volatile private var generation = 0
  // The width the cached bitmaps were drawn at; a resize or settled zoom redraws them sharp.
  @Volatile private var cacheWidth = 0
  private var scale = 1f
  // The zoom the pages are drawn at, updated only when a gesture settles.
  private var renderScale = 1f
  // Sub-pixel scroll left over from focal-point zooming, so a slow pinch does not drift.
  private var scrollRemainder = 0f
  private var pinching = false
  private var zoomAnimation: ValueAnimator? = null

  private val pinch = ScaleGestureDetector(
    context,
    object : ScaleGestureDetector.SimpleOnScaleGestureListener() {
      override fun onScaleBegin(detector: ScaleGestureDetector): Boolean {
        stopZoomAnimation()
        pinching = true
        parent?.requestDisallowInterceptTouchEvent(true)
        return true
      }

      override fun onScale(detector: ScaleGestureDetector): Boolean {
        zoomTo(scale * detector.scaleFactor, detector.focusX, detector.focusY)
        return true
      }

      override fun onScaleEnd(detector: ScaleGestureDetector) {
        // The finger still down after a pinch pans, without lifting it first.
        pinching = false
        sharpen()
      }
    },
  )

  private val gestures = GestureDetector(
    context,
    object : GestureDetector.SimpleOnGestureListener() {
      override fun onDoubleTap(e: MotionEvent): Boolean {
        animateZoom(if (scale > 1.01f) 1f else DOUBLE_TAP_ZOOM, e.x, e.y)
        return true
      }

      override fun onScroll(
        e1: MotionEvent?,
        e2: MotionEvent,
        distanceX: Float,
        distanceY: Float,
      ): Boolean {
        if (pinching || scale <= 1f) return false
        parent?.requestDisallowInterceptTouchEvent(true)
        panTo(pages.translationX - distanceX)
        return true
      }
    },
  )

  init {
    addView(pages, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
  }

  // The list scrolls vertically on its own (its touch coordinates are already unscaled); this
  // view only adds pinch, double tap, and horizontal panning, and takes over during a pinch.
  override fun dispatchTouchEvent(event: MotionEvent): Boolean {
    if (event.actionMasked == MotionEvent.ACTION_DOWN) pinching = false
    val wasPinching = pinching
    pinch.onTouchEvent(event)
    gestures.onTouchEvent(event)
    if (!pinching) return super.dispatchTouchEvent(event) || true
    if (!wasPinching) {
      val cancel = MotionEvent.obtain(event).apply { action = MotionEvent.ACTION_CANCEL }
      super.dispatchTouchEvent(cancel)
      cancel.recycle()
    }
    return true
  }

  override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
    super.onSizeChanged(w, h, oldw, oldh)
    resetZoom()
  }

  private fun resetZoom() {
    stopZoomAnimation()
    scale = 1f
    renderScale = 1f
    pages.scaleX = 1f
    pages.scaleY = 1f
    pages.translationX = 0f
    post { fitListHeight() }
  }

  private fun zoomTo(target: Float, focusX: Float, focusY: Float) {
    val next = target.coerceIn(1f, MAX_ZOOM)
    if (next == scale) return
    // Keep the point under the focus still: scroll the list in its own coordinates, and move it
    // sideways on screen.
    scrollRemainder += focusY / scale - focusY / next
    val whole = scrollRemainder.toInt()
    scrollRemainder -= whole
    if (whole != 0) pages.scrollListBy(whole)
    val x = focusX - (focusX - pages.translationX) * next / scale
    scale = next
    pages.scaleX = next
    pages.scaleY = next
    fitListHeight()
    panTo(x)
  }

  /**
   * The list scales from its top, so a zoomed list keeps its own height at this view's height
   * divided by the zoom: scaled up, it fills the view exactly and scrolls to the last page's end.
   */
  private fun fitListHeight() {
    val params = pages.layoutParams ?: return
    val next = if (scale == 1f) LayoutParams.MATCH_PARENT else Math.round(height / scale)
    if (params.height == next) return
    params.height = next
    pages.layoutParams = params
  }

  private fun panTo(x: Float) {
    pages.translationX = x.coerceIn(width - width * scale, 0f)
  }

  private fun stopZoomAnimation() {
    val running = zoomAnimation ?: return
    zoomAnimation = null
    running.cancel()
  }

  private fun animateZoom(target: Float, focusX: Float, focusY: Float) {
    stopZoomAnimation()
    val animation = ValueAnimator.ofFloat(scale, target)
    animation.duration = 220
    animation.addUpdateListener { zoomTo(it.animatedValue as Float, focusX, focusY) }
    animation.addListener(object : AnimatorListenerAdapter() {
      override fun onAnimationEnd(ended: Animator) {
        // A pinch that interrupts the animation sharpens when it ends instead.
        if (zoomAnimation !== ended) return
        zoomAnimation = null
        sharpen()
      }
    })
    zoomAnimation = animation
    animation.start()
  }

  // Redraws the pages on screen at the current zoom; each keeps its old bitmap until the new one
  // arrives, and pages scrolled in later draw at this zoom too.
  private fun sharpen() {
    if (renderScale == scale) return
    renderScale = scale
    val width = useRenderWidth(pages.width)
    for (i in 0 until pages.childCount) {
      val image = pages.getChildAt(i) as? ImageView ?: continue
      val index = image.tag as? Int ?: continue
      render(index, width, image)
    }
  }

  // The width pages draw at; the cache is cleared whenever it changes.
  private fun useRenderWidth(layoutWidth: Int): Int {
    val width = (layoutWidth.coerceAtLeast(1) * renderScale).toInt()
    if (width != cacheWidth) {
      bitmaps.evictAll()
      cacheWidth = width
    }
    return width
  }

  // A very tall or very zoomed page draws at a lower resolution instead of exhausting memory.
  private fun drawWidth(index: Int, width: Int) =
    minOf(width, Math.sqrt(MAX_PIXELS / aspect[index].toDouble()).toInt()).coerceAtLeast(1)

  fun load(next: String) {
    if (next == uri) return
    uri = next
    val current = ++generation
    pages.adapter = null
    bitmaps.evictAll()
    // Another document opens at its own start, not at the last one's zoom.
    resetZoom()
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
      if (current != generation || width != cacheWidth || index >= page.pageCount) return@execute
      val drawWidth = drawWidth(index, width)
      // A page PdfRenderer cannot draw stays blank instead of crashing the app.
      val bitmap = try {
        page.openPage(index).use { opened ->
          val height = (drawWidth * aspect[index]).toInt().coerceAtLeast(1)
          Bitmap.createBitmap(drawWidth, height, Bitmap.Config.ARGB_8888).also {
            it.eraseColor(Color.WHITE)
            opened.render(it, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
          }
        }
      } catch (_: Throwable) {
        return@execute
      }
      main.post {
        if (current != generation || width != cacheWidth) return@post
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
      val renderWidth = useRenderWidth(width)
      image.layoutParams =
        ViewGroup.LayoutParams(width, (width * aspect[position]).toInt().coerceAtLeast(1))
      val shown = if (image.tag == position) (image.drawable as? BitmapDrawable)?.bitmap else null
      image.tag = position
      // A zoomed page can be too large to stay in the cache, so keep what is already showing.
      if (shown != null && shown.width == drawWidth(position, renderWidth)) return image
      val cached = bitmaps.get(position)
      if (cached != null || shown == null) image.setImageBitmap(cached)
      if (cached == null) render(position, renderWidth, image)
      return image
    }
  }
}

private const val MAX_PIXELS = 16_000_000.0
private const val MAX_ZOOM = 4f
private const val DOUBLE_TAP_ZOOM = 2.5f
