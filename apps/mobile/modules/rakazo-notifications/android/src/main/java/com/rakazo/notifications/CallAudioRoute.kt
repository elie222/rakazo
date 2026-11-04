package com.rakazo.notifications

import android.content.Context
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build

/** Own the communication route only for the live call that selected it. */
class CallAudioRoute(context: Context) {
  private val audio = context.getSystemService(AudioManager::class.java)
  private var callId: String? = null
  private var previousMode = AudioManager.MODE_NORMAL
  private var previousSpeaker = false

  @Synchronized
  @Suppress("DEPRECATION")
  fun start(id: String) {
    stop()
    previousMode = audio.mode
    previousSpeaker = audio.isSpeakerphoneOn
    callId = id
    try {
      audio.mode = AudioManager.MODE_IN_COMMUNICATION
      setSpeaker(id, true)
    } catch (error: Exception) {
      stop(id)
      throw error
    }
  }

  @Synchronized
  @Suppress("DEPRECATION")
  fun setSpeaker(id: String, enabled: Boolean) {
    check(callId == id) { "This voice call has ended." }
    if (Build.VERSION.SDK_INT >= 31) {
      val type = if (enabled) AudioDeviceInfo.TYPE_BUILTIN_SPEAKER else AudioDeviceInfo.TYPE_BUILTIN_EARPIECE
      val device = audio.availableCommunicationDevices.firstOrNull { it.type == type }
      check(device != null && audio.setCommunicationDevice(device)) {
        "The requested call speaker is unavailable."
      }
    } else {
      audio.isSpeakerphoneOn = enabled
      check(audio.isSpeakerphoneOn == enabled) { "Could not change the call speaker." }
    }
  }

  @Synchronized
  @Suppress("DEPRECATION")
  fun stop(id: String? = null) {
    if (callId == null || (id != null && id != callId)) return
    callId = null
    try {
      if (Build.VERSION.SDK_INT >= 31) audio.clearCommunicationDevice()
      else audio.isSpeakerphoneOn = previousSpeaker
    } finally {
      if (audio.mode == AudioManager.MODE_IN_COMMUNICATION) audio.mode = previousMode
    }
  }
}
