package com.rakazo.notifications

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.os.Parcel
import android.os.Parcelable
import android.util.Base64
import expo.modules.notifications.notifications.interfaces.INotificationContent
import org.json.JSONObject

/** Expo parcels requests between services and activities; retain sender images across that boundary. */
class AgentNotificationContent(private val content: INotificationContent) : INotificationContent by content {
  override fun containsImage(): Boolean = body?.optJSONObject("sender")?.optString("avatar")?.isNotBlank() == true
  override suspend fun getImage(context: Context): Bitmap? = senderPortrait(body?.optJSONObject("sender"))
  override fun writeToParcel(parcel: Parcel, flags: Int) { parcel.writeParcelable(content, flags) }
  override fun describeContents(): Int = 0

  companion object {
    @JvmField val CREATOR = object : Parcelable.Creator<AgentNotificationContent> {
      override fun createFromParcel(parcel: Parcel): AgentNotificationContent =
        AgentNotificationContent(parcel.readParcelable<INotificationContent>(AgentNotificationContent::class.java.classLoader)!!)
      override fun newArray(size: Int): Array<AgentNotificationContent?> = arrayOfNulls(size)
    }
  }
}

internal fun senderPortrait(sender: JSONObject?): Bitmap? = runCatching {
  val encoded = sender?.optString("avatar") ?: return@runCatching null
  if (encoded.isBlank() || encoded.length > 1400) return@runCatching null
  val bytes = Base64.decode(encoded, Base64.DEFAULT)
  val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
  BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
  if (bounds.outWidth !in 1..96 || bounds.outHeight !in 1..96) return@runCatching null
  BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
}.getOrNull()
