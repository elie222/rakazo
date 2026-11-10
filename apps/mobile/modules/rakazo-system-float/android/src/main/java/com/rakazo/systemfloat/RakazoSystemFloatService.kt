package com.rakazo.systemfloat

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.IBinder
import android.provider.Settings
import android.text.TextUtils
import android.util.TypedValue
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.view.inputmethod.InputMethodManager
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.ImageButton
import android.widget.LinearLayout
import android.widget.TextView
import java.util.Locale
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * A real system floating window for the computer screen: a WindowManager
 * overlay (TYPE_APPLICATION_OVERLAY) hosting the live noVNC page, so the
 * screen stays visible over the desktop and other apps after leaving
 * Rakazo. A foreground service keeps it alive while it is up; the window
 * goes down when the computer run ends (the JS side calls hide), when the
 * user closes it, or when the process dies.
 *
 * The window is draggable by its title bar and resizable from its
 * bottom-right grip, keeping the same 16:10 frame as the in-app float.
 * Touches outside the window pass through to the app underneath
 * (FLAG_NOT_TOUCH_MODAL); the window itself takes focus when tapped, so
 * the remote screen accepts keyboard input.
 */
class RakazoSystemFloatService : Service() {
  companion object {
    const val ACTION_SHOW = "com.rakazo.systemfloat.SHOW"
    const val ACTION_UPDATE_URL = "com.rakazo.systemfloat.UPDATE_URL"
    const val ACTION_HIDE = "com.rakazo.systemfloat.HIDE"
    const val EXTRA_URL = "url"
    const val EXTRA_TITLE = "title"
    const val EXTRA_LOCALE = "locale"

    private const val NOTIFICATION_ID = 9401
    private const val CHANNEL_ID = "rakazo_system_float"

    /** The window's default width, in dp — the same 300 as the in-app float. */
    private const val DEFAULT_WIDTH_DP = 300
    /** The narrowest window: its screen stays readable, like the in-app float. */
    private const val MIN_WIDTH_DP = 160
    private const val BAR_HEIGHT_DP = 36
    private const val TOP_DP = 120
    private const val EDGE_DP = 16
    private const val GRIP_DP = 28

    @Volatile
    var isRunning = false
  }

  private var windowManager: WindowManager? = null
  private var overlay: FrameLayout? = null
  private var overlayParams: WindowManager.LayoutParams? = null
  private var titleView: TextView? = null
  private var webView: WebView? = null
  private var currentUrl: String? = null
  private var currentLocale = ""
  /** The window's size and position before it was maximized, for restoring. */
  private var savedParams: WindowManager.LayoutParams? = null
  private var isMaximized = false
  private var maximizeButton: ImageButton? = null
  private var keyboardButton: ImageButton? = null
  private var openButton: ImageButton? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    when (intent?.action) {
      ACTION_HIDE -> {
        stopSelf()
        return START_NOT_STICKY
      }
      ACTION_UPDATE_URL -> {
        val url = intent.getStringExtra(EXTRA_URL).orEmpty()
        if (url.isNotBlank()) loadUrl(url)
        return START_NOT_STICKY
      }
      ACTION_SHOW -> {
        if (!Settings.canDrawOverlays(this)) {
          stopSelf()
          return START_NOT_STICKY
        }
        val url = intent.getStringExtra(EXTRA_URL).orEmpty()
        if (url.isBlank()) {
          stopSelf()
          return START_NOT_STICKY
        }
        val title = intent.getStringExtra(EXTRA_TITLE).orEmpty()
        val locale = intent.getStringExtra(EXTRA_LOCALE).orEmpty()
        if (overlay == null) {
          createOverlay(url, title, locale)
        } else {
          if (title.isNotBlank()) titleView?.text = title
          loadUrl(url)
        }
        return START_NOT_STICKY
      }
      else -> return START_NOT_STICKY
    }
  }

  override fun onDestroy() {
    try {
      overlay?.let { windowManager?.removeView(it) }
    } catch (_: Exception) {
      // Already removed.
    }
    overlay = null
    overlayParams = null
    titleView = null
    maximizeButton = null
    keyboardButton = null
    openButton = null
    savedParams = null
    isMaximized = false
    webView?.destroy()
    webView = null
    currentUrl = null
    if (Build.VERSION.SDK_INT >= 24) stopForeground(STOP_FOREGROUND_REMOVE)
    isRunning = false
    super.onDestroy()
  }

  private fun loadUrl(url: String) {
    if (url == currentUrl) return
    currentUrl = url
    webView?.loadUrl(url)
  }

  /** Brings up the soft keyboard for the screen, so the phone can type into the computer. */
  private fun showKeyboard() {
    val view = webView ?: return
    view.requestFocus()
    val inputMethodManager = getSystemService(INPUT_METHOD_SERVICE) as InputMethodManager
    inputMethodManager.showSoftInput(view, InputMethodManager.SHOW_IMPLICIT)
  }

  /**
   * The phone drives the computer only once the window is expanded: the
   * popup takes control when it opens, but the small floating window is
   * just for watching, so its keyboard and return-to-app buttons stay
   * hidden until the window is maximized. Expand and close always stay:
   * expand is how the window is taken over, and close is the only way to
   * dismiss it. The return path stays available through the foreground
   * notification while the buttons are hidden.
   */
  private fun updateOperationButtons() {
    val visibility = if (isMaximized) View.VISIBLE else View.GONE
    keyboardButton?.visibility = visibility
    openButton?.visibility = visibility
  }

  /** Toggles the window between its floating size and the full screen. */
  private fun toggleMaximize() {
    val manager = windowManager ?: return
    val root = overlay ?: return
    val params = overlayParams ?: return
    val metrics = resources.displayMetrics
    if (isMaximized) {
      val saved = savedParams ?: return
      params.width = saved.width
      params.height = saved.height
      params.x = saved.x
      params.y = saved.y
      savedParams = null
      isMaximized = false
      maximizeButton?.setImageResource(R.drawable.ic_rakazo_system_float_maximize)
      maximizeButton?.contentDescription = getString(R.string.rakazo_system_float_maximize)
    } else {
      savedParams = WindowManager.LayoutParams().apply {
        copyFrom(params)
      }
      params.width = metrics.widthPixels
      params.height = metrics.heightPixels
      params.x = 0
      params.y = 0
      isMaximized = true
      maximizeButton?.setImageResource(R.drawable.ic_rakazo_system_float_restore)
      maximizeButton?.contentDescription = getString(R.string.rakazo_system_float_restore)
    }
    updateOperationButtons()
    manager.updateViewLayout(root, params)
  }

  private fun createOverlay(url: String, title: String, locale: String) {
    currentLocale = locale
    val manager = getSystemService(WINDOW_SERVICE) as WindowManager
    windowManager = manager
    val metrics = resources.displayMetrics
    val barPx = dp(BAR_HEIGHT_DP)
    val widthPx = dp(DEFAULT_WIDTH_DP)
    val heightPx = (widthPx * 10 / 16) + barPx

    val root = FrameLayout(this).apply {
      background = GradientDrawable().apply {
        setColor(Color.rgb(0x14, 0x14, 0x14))
        cornerRadius = dp(12).toFloat()
      }
    }
    val column = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      layoutParams = FrameLayout.LayoutParams(
        FrameLayout.LayoutParams.MATCH_PARENT,
        FrameLayout.LayoutParams.MATCH_PARENT,
      )
    }
    val bar = LinearLayout(this).apply {
      orientation = LinearLayout.HORIZONTAL
      layoutParams = LinearLayout.LayoutParams(
        LinearLayout.LayoutParams.MATCH_PARENT,
        barPx,
      )
      setPadding(dp(12), 0, dp(4), 0)
      gravity = Gravity.CENTER_VERTICAL
    }
    val titleText = TextView(this).apply {
      layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.MATCH_PARENT, 1f)
      text = title
      textSize = 13f
      setTextColor(Color.WHITE)
      maxLines = 1
      ellipsize = TextUtils.TruncateAt.END
      gravity = Gravity.CENTER_VERTICAL
    }
    titleView = titleText
    val keyboardButton = ImageButton(this).apply {
      layoutParams = LinearLayout.LayoutParams(barPx, barPx)
      setImageResource(R.drawable.ic_rakazo_system_float_keyboard)
      setBackgroundResource(0)
      contentDescription = getString(R.string.rakazo_system_float_keyboard)
      setOnClickListener { showKeyboard() }
    }
    this.keyboardButton = keyboardButton
    val maximizeButton = ImageButton(this).apply {
      layoutParams = LinearLayout.LayoutParams(barPx, barPx)
      setImageResource(R.drawable.ic_rakazo_system_float_maximize)
      setBackgroundResource(0)
      contentDescription = getString(R.string.rakazo_system_float_maximize)
      setOnClickListener { toggleMaximize() }
    }
    this.maximizeButton = maximizeButton
    val openButton = ImageButton(this).apply {
      layoutParams = LinearLayout.LayoutParams(barPx, barPx)
      setImageResource(R.drawable.ic_rakazo_system_float_open)
      setBackgroundResource(0)
      contentDescription = getString(R.string.rakazo_system_float_open_app)
      setOnClickListener { openApp() }
    }
    this.openButton = openButton
    val closeButton = ImageButton(this).apply {
      layoutParams = LinearLayout.LayoutParams(barPx, barPx)
      setImageResource(R.drawable.ic_rakazo_system_float_close)
      setBackgroundResource(0)
      contentDescription = getString(R.string.rakazo_system_float_close)
      setOnClickListener { stopSelf() }
    }
    bar.addView(titleText)
    bar.addView(maximizeButton)
    bar.addView(keyboardButton)
    bar.addView(openButton)
    bar.addView(closeButton)
    // The window opens small, so the operation buttons start hidden.
    updateOperationButtons()

    val screen = WebView(this).apply {
      layoutParams = LinearLayout.LayoutParams(
        LinearLayout.LayoutParams.MATCH_PARENT,
        0,
        1f,
      )
      settings.javaScriptEnabled = true
      settings.domStorageEnabled = true
      // Pinch to zoom the desktop: the built-in zoom controls are the
      // pinch gesture, with the on-screen +/- buttons hidden.
      settings.setSupportZoom(true)
      settings.builtInZoomControls = true
      settings.displayZoomControls = false
      isFocusableInTouchMode = true
      webViewClient = WebViewClient()
    }
    webView = screen
    column.addView(bar)
    column.addView(screen)
    root.addView(column)

    val grip = View(this).apply {
      layoutParams = FrameLayout.LayoutParams(dp(GRIP_DP), dp(GRIP_DP), Gravity.BOTTOM or Gravity.END)
      setBackgroundResource(R.drawable.ic_rakazo_system_float_resize)
      contentDescription = getString(R.string.rakazo_system_float_resize)
    }
    root.addView(grip)

    val params = WindowManager.LayoutParams(
      widthPx,
      heightPx,
      if (Build.VERSION.SDK_INT >= 26) {
        WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
      } else {
        @Suppress("DEPRECATION")
        WindowManager.LayoutParams.TYPE_PHONE
      },
      WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
      PixelFormat.TRANSLUCENT,
    ).apply {
      gravity = Gravity.TOP or Gravity.START
      x = max(dp(EDGE_DP), metrics.widthPixels - widthPx - dp(EDGE_DP))
      y = dp(TOP_DP)
    }
    overlayParams = params
    overlay = root

    bar.setOnTouchListener(
      DragTouchListener(root, manager, params, metrics.widthPixels, metrics.heightPixels) { isMaximized },
    )
    grip.setOnTouchListener(
      ResizeTouchListener(root, manager, params, metrics.widthPixels, metrics.heightPixels, barPx) { isMaximized },
    )

    startForegroundNotification()
    manager.addView(root, params)
    isRunning = true
    loadUrl(url)
  }

  private fun startForegroundNotification() {
    val copyContext = localizedContext(this, currentLocale)
    if (Build.VERSION.SDK_INT >= 26) {
      val manager = getSystemService(NotificationManager::class.java)
      manager.createNotificationChannel(
        NotificationChannel(
          CHANNEL_ID,
          copyContext.getString(R.string.rakazo_system_float_channel),
          NotificationManager.IMPORTANCE_LOW,
        ),
      )
    }
    val notification = notificationBuilder(copyContext)
      .setSmallIcon(R.drawable.ic_rakazo_system_float)
      .setContentTitle(copyContext.getString(R.string.rakazo_system_float_title))
      .setContentText(copyContext.getString(R.string.rakazo_system_float_text))
      .setContentIntent(openAppPendingIntent())
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setCategory(Notification.CATEGORY_SERVICE)
      .build()
    if (Build.VERSION.SDK_INT >= 29) {
      startForeground(
        NOTIFICATION_ID,
        notification,
        ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE,
      )
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }
  }

  @Suppress("DEPRECATION")
  private fun notificationBuilder(copyContext: Context): Notification.Builder =
    if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, CHANNEL_ID)
    else Notification.Builder(this)

  private fun openApp() {
    val intent = packageManager.getLaunchIntentForPackage(packageName)
      ?: Intent(Intent.ACTION_VIEW, android.net.Uri.parse("rakazo://"))
    intent.flags = Intent.FLAG_ACTIVITY_NEW_TASK or
      Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
    startActivity(intent)
  }

  private fun openAppPendingIntent(): PendingIntent {
    val intent = packageManager.getLaunchIntentForPackage(packageName)
      ?: Intent(Intent.ACTION_VIEW, android.net.Uri.parse("rakazo://"))
    intent.flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
    return PendingIntent.getActivity(
      this,
      0,
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
  }

  private fun dp(value: Int): Int =
    TypedValue.applyDimension(
      TypedValue.COMPLEX_UNIT_DIP,
      value.toFloat(),
      resources.displayMetrics,
    ).roundToInt()

  /** Drags the window by its title bar, keeping it inside the screen. */
  private class DragTouchListener(
    private val overlayRoot: View,
    private val manager: WindowManager,
    private val params: WindowManager.LayoutParams,
    private val screenWidth: Int,
    private val screenHeight: Int,
    private val isMaximized: () -> Boolean,
  ) : View.OnTouchListener {
    private var downRawX = 0f
    private var downRawY = 0f
    private var downX = 0
    private var downY = 0

    @SuppressLint("ClickableViewAccessibility")
    override fun onTouch(view: View, event: MotionEvent): Boolean {
      if (isMaximized()) return false
      when (event.actionMasked) {
        MotionEvent.ACTION_DOWN -> {
          downRawX = event.rawX
          downRawY = event.rawY
          downX = params.x
          downY = params.y
          return true
        }
        MotionEvent.ACTION_MOVE -> {
          val edge = TypedValue.applyDimension(
            TypedValue.COMPLEX_UNIT_DIP,
            EDGE_DP.toFloat(),
            view.resources.displayMetrics,
          ).roundToInt()
          params.x = clamp(
            downX + (event.rawX - downRawX).roundToInt(),
            edge,
            max(edge, screenWidth - params.width - edge),
          )
          params.y = clamp(
            downY + (event.rawY - downRawY).roundToInt(),
            edge,
            max(edge, screenHeight - params.height - edge),
          )
          manager.updateViewLayout(overlayRoot, params)
          return true
        }
        else -> return false
      }
    }
  }

  /**
   * Resizes the window from its bottom-right grip, keeping the 16:10 frame:
   * the drag takes its dominant axis, like the in-app float.
   */
  private class ResizeTouchListener(
    private val overlayRoot: View,
    private val manager: WindowManager,
    private val params: WindowManager.LayoutParams,
    private val screenWidth: Int,
    private val screenHeight: Int,
    private val barPx: Int,
    private val isMaximized: () -> Boolean,
  ) : View.OnTouchListener {
    private var downRawX = 0f
    private var downRawY = 0f
    private var startWidth = 0

    @SuppressLint("ClickableViewAccessibility")
    override fun onTouch(view: View, event: MotionEvent): Boolean {
      if (isMaximized()) return false
      val metrics = view.resources.displayMetrics
      fun dpPx(value: Int): Int =
        TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value.toFloat(), metrics).roundToInt()
      when (event.actionMasked) {
        MotionEvent.ACTION_DOWN -> {
          downRawX = event.rawX
          downRawY = event.rawY
          startWidth = params.width
          return true
        }
        MotionEvent.ACTION_MOVE -> {
          val minWidth = dpPx(MIN_WIDTH_DP)
          val maxWidth = max(
            minWidth,
            min(
              (screenWidth * 0.9).roundToInt(),
              ((screenHeight * 0.9 - barPx) * 1.6).roundToInt(),
            ),
          )
          val delta = max(event.rawX - downRawX, (event.rawY - downRawY) * 1.6f)
          val width = clamp(startWidth + delta.roundToInt(), minWidth, maxWidth)
          params.width = width
          params.height = (width * 10 / 16) + barPx
          manager.updateViewLayout(overlayRoot, params)
          return true
        }
        else -> return false
      }
    }
  }
}

private fun clamp(value: Int, min: Int, max: Int): Int = max(min, min(value, max))

/** The app's UI locale, for the foreground-service notification strings. */
private fun localizedContext(base: Context, tag: String): Context {
  if (tag.isBlank()) return base
  // The JS locale "zh" is Simplified Chinese; Android's resource folder is zh-rCN.
  val languageTag = if (tag == "zh") "zh-CN" else tag
  val configuration = Configuration(base.resources.configuration)
  configuration.setLocale(Locale.forLanguageTag(languageTag))
  return base.createConfigurationContext(configuration)
}
