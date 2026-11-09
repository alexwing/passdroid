package com.passdroid.next

import android.app.Activity
import android.content.ContentValues
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import app.tauri.Logger
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.IOException

@InvokeArg
class SaveExportArgs {
  var fileName: String = ""
  var mimeType: String = "application/octet-stream"
  var contents: String = ""
}

// Saves exports straight into Download/Passdroid through MediaStore. The document
// picker (ACTION_CREATE_DOCUMENT) loses its result on some devices (MIUI/HyperOS),
// leaving an empty file and no feedback, so exports must not depend on it.
@TauriPlugin
class ExportPlugin(private val activity: Activity) : Plugin(activity) {
  @Command
  fun saveExport(invoke: Invoke) {
    val args = invoke.parseArgs(SaveExportArgs::class.java)
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
      invoke.reject("export_unsupported")
      return
    }
    Thread {
      try {
        invoke.resolve(save(args))
      } catch (ex: Exception) {
        Logger.error("Export failed: ${ex.message}")
        invoke.reject("export_write_failed")
      }
    }.start()
  }

  private fun save(args: SaveExportArgs): JSObject {
    val resolver = activity.contentResolver
    val bytes = args.contents.toByteArray(Charsets.UTF_8)
    val values = ContentValues().apply {
      put(MediaStore.MediaColumns.DISPLAY_NAME, args.fileName)
      put(MediaStore.MediaColumns.MIME_TYPE, args.mimeType)
      put(MediaStore.MediaColumns.RELATIVE_PATH, "${Environment.DIRECTORY_DOWNLOADS}/Passdroid")
      put(MediaStore.MediaColumns.IS_PENDING, 1)
    }
    val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
      ?: throw IOException("MediaStore insert returned null")

    try {
      val out = resolver.openOutputStream(uri, "wt") ?: throw IOException("No output stream")
      out.use {
        it.write(bytes)
        it.flush()
      }
      val readBack = (resolver.openInputStream(uri) ?: throw IOException("No input stream"))
        .use { it.readBytes() }
      if (!readBack.contentEquals(bytes)) throw IOException("Read-back mismatch")

      values.clear()
      values.put(MediaStore.MediaColumns.IS_PENDING, 0)
      resolver.update(uri, values, null, null)

      // MediaStore may rename on a collision, so report the name it actually used.
      var name = args.fileName
      var folder = "${Environment.DIRECTORY_DOWNLOADS}/Passdroid/"
      resolver.query(
        uri,
        arrayOf(MediaStore.MediaColumns.DISPLAY_NAME, MediaStore.MediaColumns.RELATIVE_PATH),
        null,
        null,
        null,
      )?.use { cursor ->
        if (cursor.moveToFirst()) {
          cursor.getString(0)?.let { name = it }
          cursor.getString(1)?.let { folder = it }
        }
      }

      val ret = JSObject()
      ret.put("name", name)
      ret.put("path", folder + name)
      ret.put("readBack", String(readBack, Charsets.UTF_8))
      return ret
    } catch (ex: Exception) {
      // Never leave a half-written or empty file behind.
      try {
        resolver.delete(uri, null, null)
      } catch (_: Exception) {
      }
      throw ex
    }
  }
}
