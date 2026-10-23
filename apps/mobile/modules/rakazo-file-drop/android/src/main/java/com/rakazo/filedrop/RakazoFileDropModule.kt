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

    Events("onFilesDropped", "onDropStarted")

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
    // Tells the thread which chat the files were dropped over, before the copy
    // gives the user time to open another one.
    sendEvent("onDropStarted", emptyMap<String, Any>())
    // The read grant for another app's content lasts until it is released.
    val permissions = activity.requestDragAndDropPermissions(event)
    Thread {
      val files = mutableListOf<Map<String, Any>>()
      val tooLarge = mutableListOf<Map<String, Any>>()
      val notCopied = mutableListOf<String>()
      var copiedBytes = 0.0
      try {
        for (uri in uris) {
          // A drop is bounded work: the thread keeps a handful of attachments, so
          // copying more than that only fills the cache with files nobody reads.
          // The files left behind are named instead, so the chat can say the batch
          // held more than one message can carry.
          val taken = files.size >= MAX_DROP_FILES || copiedBytes >= MAX_DROP_BYTES
          if (taken) {
            if (notCopied.size < MAX_REPORTED_SKIPS) {
              displayName(activity, uri)?.let { notCopied.add(it) }
            }
            continue
          }
          val file = copyToCache(activity, uri, tooLarge)
          if (file != null) {
            files.add(file)
            copiedBytes += (file["size"] as? Double) ?: 0.0
          }
        }
      } finally {
        permissions?.release()
      }
      if (files.isNotEmpty() || tooLarge.isNotEmpty() || notCopied.isNotEmpty()) {
        sendEvent(
          "onFilesDropped",
          mapOf("files" to files, "tooLarge" to tooLarge, "skipped" to notCopied),
        )
      }
    }.start()
    return true
  }

  private fun displayName(activity: Activity, uri: Uri): String? = runCatching {
    var queried: String? = null
    activity.contentResolver
      .query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
      ?.use { cursor ->
        if (cursor.moveToFirst() && !cursor.isNull(0)) queried = cursor.getString(0)
      }
    queried?.substringAfterLast('/')?.takeIf { it.isNotBlank() }
  }.getOrNull()

  private fun copyToCache(
    activity: Activity,
    uri: Uri,
    tooLarge: MutableList<Map<String, Any>>,
  ): Map<String, Any>? {
    val resolver = activity.contentResolver
    val directory = File(activity.cacheDir, "dropped/${UUID.randomUUID()}")
    var refused: String? = null
    // Provider calls and the copy stay inside one guard: a dropped URI can deny
    // access or fail mid-stream, and that must not escape the worker thread.
    val file: Map<String, Any>? = runCatching {
      val fileName = displayName(activity, uri) ?: "file"
      directory.mkdirs()
      val target = File(directory, fileName)
      var copied = 0L
      var oversized = false
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
              oversized = true
              break
            }
            sink.write(buffer, 0, read)
          }
        }
      } ?: return@runCatching null
      if (oversized) {
        refused = fileName
        null
      } else {
        mapOf(
          "uri" to Uri.fromFile(target).toString(),
          "name" to fileName,
          "mimeType" to (resolver.getType(uri) ?: "application/octet-stream"),
          "size" to copied.toDouble(),
        )
      }
    }.getOrNull()
    if (file == null) {
      directory.deleteRecursively()
      refused?.let { tooLarge.add(mapOf("name" to it, "limit" to MAX_COPY_BYTES.toDouble())) }
    }
    return file
  }

  private companion object {
    // Storage guards only: the attachment limit itself is applied by the thread,
    // which knows the server's configured size and how many files fit.
    const val MAX_COPY_BYTES = 64L * 1024 * 1024
    const val MAX_DROP_BYTES = 64.0 * 1024 * 1024
    const val MAX_DROP_FILES = 8
    const val MAX_REPORTED_SKIPS = 6
    const val COPY_BUFFER_BYTES = 64 * 1024
  }
}
