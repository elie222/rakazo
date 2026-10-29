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
import java.util.concurrent.Executors

class RakazoFileDropModule : Module() {
  private val mainHandler = Handler(Looper.getMainLooper())
  private var attached: Activity? = null
  private data class Limits(val enabled: Boolean, val maxBytes: Long, val maxFiles: Int)
  @Volatile private var limits = Limits(false, 0, 0)
  private val worker = Executors.newSingleThreadExecutor()
  private var handledDrop = false

  private val dragListener = View.OnDragListener { _, event -> onDrag(event) }

  override fun definition() = ModuleDefinition {
    Name("RakazoFileDrop")

    Events("onFilesDropped", "onDropStarted")

    Function("setDropTarget") { enabled: Boolean, maxBytes: Double, maxFiles: Int ->
      limits = Limits(
        enabled && maxBytes.isFinite() && maxBytes > 0,
        maxBytes.toLong().coerceIn(0, Long.MAX_VALUE - 1),
        maxFiles.coerceAtLeast(0),
      )
    }
    AsyncFunction("release") { uri: String ->
      val context = appContext.reactContext
      if (context != null) runCatching {
        val root = File(context.cacheDir, "dropped").canonicalFile
        val parsed = Uri.parse(uri)
        if (parsed.scheme == "file") {
          val target = File(parsed.path ?: "").canonicalFile
          if (target.path.startsWith(root.path + File.separator) && target.isFile) {
            target.delete()
            target.parentFile?.takeIf { it != root }?.delete()
          }
        }
      }
      Unit
    }
    OnCreate {
      // Outbox previews live under outbox/, and composer previews are data URIs.
      // Queue the sweep before any copies so it cannot delete a new drop.
      val context = appContext.reactContext
      worker.execute {
        if (context != null) runCatching { File(context.cacheDir, "dropped").deleteRecursively() }
      }
      mainHandler.post { attach() }
    }
    OnActivityEntersForeground { attach() }
    OnActivityDestroys { detach() }
    OnDestroy {
      limits = Limits(false, 0, 0)
      mainHandler.post { detach() }
      worker.shutdown()
    }
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
      DragEvent.ACTION_DRAG_STARTED -> {
        handledDrop = false
        limits.enabled && limits.maxFiles > 0 && (event.clipDescription?.mimeTypeCount ?: 0) > 0
      }
      DragEvent.ACTION_DROP -> drop(event)
      else -> true
    }
  }

  private fun drop(event: DragEvent): Boolean {
    val bounds = limits
    if (!bounds.enabled || bounds.maxFiles == 0 || handledDrop) return false
    handledDrop = true
    val activity = attached ?: return false
    val clip = event.clipData ?: return false
    // Cross-app files must use granted content URIs, never app-private file paths.
    val uris = (0 until minOf(clip.itemCount, bounds.maxFiles)).mapNotNull {
      clip.getItemAt(it).uri?.takeIf { uri -> uri.scheme == "content" }
    }
    if (uris.isEmpty()) return false
    val permissions = try {
      activity.requestDragAndDropPermissions(event)
    } catch (_: SecurityException) {
      null
    } ?: return false
    sendEvent("onDropStarted", emptyMap<String, Any>())
    worker.execute {
      val directory = File(activity.cacheDir, "dropped/${UUID.randomUUID()}")
      val payload = try {
        val files = uris.mapNotNull { copyToCache(activity, it, directory, bounds.maxBytes) }
        // Bound metadata work as well as the names included in the notice.
        val reportEnd = minOf(clip.itemCount.toLong(), bounds.maxFiles.toLong() + 6).toInt()
        val skipped = (bounds.maxFiles until reportEnd).mapNotNull {
          clip.getItemAt(it).uri?.takeIf { uri -> uri.scheme == "content" }?.let { uri ->
            metadata(activity, uri).name
          }
        }
        mapOf("files" to files, "skipped" to skipped)
      } catch (_: Exception) {
        directory.deleteRecursively()
        mapOf("files" to emptyList<Any>())
      } finally {
        runCatching { permissions.release() }
        directory.delete() // Remove empty directories after failed/oversized drops.
      }
      sendEvent("onFilesDropped", payload)
    }
    return true
  }

  private data class Metadata(val name: String, val size: Long)

  private fun metadata(activity: Activity, uri: Uri): Metadata {
    var name: String? = null
    var size = -1L
    runCatching {
      activity.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { cursor ->
        if (cursor.moveToFirst()) {
          val nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
          val sizeIndex = cursor.getColumnIndex(OpenableColumns.SIZE)
          if (nameIndex >= 0 && !cursor.isNull(nameIndex)) name = cursor.getString(nameIndex)
          if (sizeIndex >= 0 && !cursor.isNull(sizeIndex)) size = cursor.getLong(sizeIndex)
        }
      }
    }
    return Metadata(safeName(name), size)
  }

  private fun safeName(name: String?): String {
    val cleaned = name.orEmpty().replace("/", "").replace("\\", "").take(120)
    return cleaned.takeIf {
      it.isNotBlank() && it != "." && it != ".." && it.none { char -> Character.isISOControl(char) }
    } ?: "file"
  }

  private fun copyToCache(activity: Activity, uri: Uri, directory: File, maxBytes: Long): Map<String, Any>? {
    var target: File? = null
    return try {
      val resolver = activity.contentResolver
      val info = metadata(activity, uri)
      val metadata = mapOf<String, Any>(
        "name" to info.name,
        "mimeType" to (resolver.getType(uri) ?: "application/octet-stream"),
      )
      if (info.size > maxBytes) return metadata + mapOf("size" to info.size.toDouble())
      directory.mkdirs()
      val destination = File(directory, UUID.randomUUID().toString())
      target = destination
      var bytes = 0L
      val input = resolver.openInputStream(uri) ?: return null
      input.use { source ->
        destination.outputStream().use { sink ->
          val buffer = ByteArray(8192)
          while (true) {
            val count = source.read(buffer, 0, minOf(buffer.size.toLong(), maxBytes - bytes + 1).toInt())
            if (count < 0) break
            bytes += count
            if (bytes > maxBytes) break
            sink.write(buffer, 0, count)
          }
        }
      }
      if (bytes > maxBytes) {
        destination.delete()
        metadata + mapOf("size" to bytes.toDouble())
      } else {
        metadata + mapOf("uri" to Uri.fromFile(destination).toString(), "size" to bytes.toDouble())
      }
    } catch (_: Exception) {
      target?.delete()
      null
    }
  }
}
