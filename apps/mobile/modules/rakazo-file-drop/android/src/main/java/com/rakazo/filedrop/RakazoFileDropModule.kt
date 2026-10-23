package com.rakazo.filedrop

import android.app.Activity
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.provider.OpenableColumns
import android.view.DragEvent
import android.view.View
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.util.UUID

class RakazoFileDropModule : Module() {
  private val mainHandler = Handler(Looper.getMainLooper())
  private var attached: Activity? = null

  private val dragListener = View.OnDragListener { _, event -> onDrag(event) }

  override fun definition() = ModuleDefinition {
    Name("RakazoFileDrop")

    Events("onFilesDropped")

    OnCreate { mainHandler.post { attach() } }
    OnActivityEntersForeground { attach() }
    OnActivityDestroys { detach() }
    OnDestroy { mainHandler.post { detach() } }
  }

  private fun attach() {
    val activity = appContext.currentActivity ?: return
    if (activity === attached) return
    detach()
    attached = activity
    activity.window?.decorView?.setOnDragListener(dragListener)
  }

  private fun detach() {
    attached?.window?.decorView?.setOnDragListener(null)
    attached = null
  }

  private fun onDrag(event: DragEvent): Boolean {
    return when (event.action) {
      DragEvent.ACTION_DRAG_STARTED -> (event.clipDescription?.mimeTypeCount ?: 0) > 0
      DragEvent.ACTION_DROP -> drop(event)
      else -> true
    }
  }

  private fun drop(event: DragEvent): Boolean {
    val activity = attached ?: return false
    val clip = event.clipData ?: return false
    val uris = (0 until clip.itemCount).mapNotNull { clip.getItemAt(it).uri }
    if (uris.isEmpty()) return false
    // The read grant for another app's content lasts until it is released.
    val permissions = activity.requestDragAndDropPermissions(event)
    Thread {
      val files = uris.mapNotNull { copyToCache(activity, it) }
      permissions?.release()
      if (files.isNotEmpty()) sendEvent("onFilesDropped", mapOf("files" to files))
    }.start()
    return true
  }

  private fun copyToCache(activity: Activity, uri: Uri): Map<String, Any>? {
    return runCatching {
      val resolver = activity.contentResolver
      var name: String? = null
      resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
        if (cursor.moveToFirst() && !cursor.isNull(0)) name = cursor.getString(0)
      }
      val displayName = name?.substringAfterLast('/')?.takeIf { it.isNotBlank() } ?: "file"
      val directory = File(activity.cacheDir, "dropped/${UUID.randomUUID()}")
      directory.mkdirs()
      val target = File(directory, displayName)
      val input = resolver.openInputStream(uri) ?: return@runCatching null
      input.use { source -> target.outputStream().use { sink -> source.copyTo(sink) } }
      mapOf(
        "uri" to Uri.fromFile(target).toString(),
        "name" to displayName,
        "mimeType" to (resolver.getType(uri) ?: "application/octet-stream"),
        "size" to target.length().toDouble(),
      )
    }.getOrNull()
  }
}
