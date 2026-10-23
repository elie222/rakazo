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
      val files = mutableListOf<Map<String, Any>>()
      val tooLarge = mutableListOf<String>()
      for (uri in uris) {
        val file = copyToCache(activity, uri, tooLarge)
        if (file != null) files.add(file)
      }
      permissions?.release()
      if (files.isNotEmpty() || tooLarge.isNotEmpty()) {
        sendEvent("onFilesDropped", mapOf("files" to files, "tooLarge" to tooLarge))
      }
    }.start()
    return true
  }

  private fun copyToCache(
    activity: Activity,
    uri: Uri,
    tooLarge: MutableList<String>,
  ): Map<String, Any>? {
    val resolver = activity.contentResolver
    var queried: String? = null
    resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
      if (cursor.moveToFirst() && !cursor.isNull(0)) queried = cursor.getString(0)
    }
    val displayName = queried?.substringAfterLast('/')?.takeIf { it.isNotBlank() } ?: "file"
    val directory = File(activity.cacheDir, "dropped/${UUID.randomUUID()}")
    directory.mkdirs()
    val target = File(directory, displayName)
    var copied = 0L
    val finished = runCatching {
      resolver.openInputStream(uri)?.use { source ->
        target.outputStream().use { sink ->
          val buffer = ByteArray(COPY_BUFFER_BYTES)
          while (true) {
            val read = source.read(buffer)
            if (read < 0) break
            copied += read
            // A drop must not fill the cache: stop at the guard, discard the
            // partial copy, and let the thread report the file as too large.
            if (copied > MAX_COPY_BYTES) {
              copied = -1
              break
            }
            sink.write(buffer, 0, read)
          }
        }
      } != null
    }.getOrDefault(false)
    if (!finished || copied < 0) {
      directory.deleteRecursively()
      if (finished && copied < 0) tooLarge.add(displayName)
      return null
    }
    return mapOf(
      "uri" to Uri.fromFile(target).toString(),
      "name" to displayName,
      "mimeType" to (resolver.getType(uri) ?: "application/octet-stream"),
      "size" to copied.toDouble(),
    )
  }

  private companion object {
    // Storage guard only: the attachment limit itself is applied by the thread,
    // which knows the server's configured size.
    const val MAX_COPY_BYTES = 64L * 1024 * 1024
    const val COPY_BUFFER_BYTES = 64 * 1024
  }
}
