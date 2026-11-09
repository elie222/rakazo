package com.rakazo.systemfloat

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * The JS bridge for the system floating window: a WindowManager overlay that
 * carries the live computer screen over other apps, kept alive by
 * [RakazoSystemFloatService]. Android only — iOS has no windows over other
 * apps, so this module does not exist there and the JS side falls back to
 * the in-app float (and the icon bubble) instead.
 */
class RakazoSystemFloatModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("RakazoSystemFloat")

    AsyncFunction("isSupported") { true }

    AsyncFunction("hasOverlayPermission") {
      Settings.canDrawOverlays(appContext.reactContext)
    }

    Function("requestOverlayPermission") {
      val context = appContext.reactContext
      val intent = Intent(
        Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
        Uri.parse("package:${context.packageName}"),
      ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      context.startActivity(intent)
    }

    /**
     * Shows the screen window over other apps. False when the overlay
     * permission is missing, the URL is empty, or the service could not
     * start — the caller falls back to the bubble or the in-app float.
     */
    AsyncFunction("show") { url: String, title: String, locale: String ->
      val context = appContext.reactContext
      if (!Settings.canDrawOverlays(context)) return@AsyncFunction false
      if (url.isBlank()) return@AsyncFunction false
      val intent = Intent(context, RakazoSystemFloatService::class.java).apply {
        action = RakazoSystemFloatService.ACTION_SHOW
        putExtra(RakazoSystemFloatService.EXTRA_URL, url)
        putExtra(RakazoSystemFloatService.EXTRA_TITLE, title)
        putExtra(RakazoSystemFloatService.EXTRA_LOCALE, locale)
      }
      return@AsyncFunction try {
        if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent)
        else context.startService(intent)
        true
      } catch (_: Exception) {
        // Starting a foreground service from the background is refused on
        // Android 12+; the caller keeps the in-app float.
        false
      }
    }

    /** Points a running window at a new screen URL, for capability rotation. */
    AsyncFunction("updateUrl") { url: String ->
      if (url.isBlank()) return@AsyncFunction
      val context = appContext.reactContext
      val intent = Intent(context, RakazoSystemFloatService::class.java).apply {
        action = RakazoSystemFloatService.ACTION_UPDATE_URL
        putExtra(RakazoSystemFloatService.EXTRA_URL, url)
      }
      try {
        context.startService(intent)
      } catch (_: Exception) {
        // The service is gone; the next show starts it again.
      }
    }

    /** Takes the window down, if it is up. */
    AsyncFunction("hide") {
      val context = appContext.reactContext
      val intent = Intent(context, RakazoSystemFloatService::class.java).apply {
        action = RakazoSystemFloatService.ACTION_HIDE
      }
      try {
        context.startService(intent)
      } catch (_: Exception) {
        // Already gone.
      }
    }

    AsyncFunction("isShowing") { RakazoSystemFloatService.isRunning }
  }
}
