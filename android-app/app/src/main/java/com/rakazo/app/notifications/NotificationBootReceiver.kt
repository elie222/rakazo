package com.rakazo.app.notifications

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.rakazo.app.network.AndroidSessionStore

class NotificationBootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
        val session = AndroidSessionStore(context)
        if (
            NotificationSettingsStore(context).settings.liveConnection &&
            session.endpoint.isNotBlank() && session.token.isNotBlank()
        ) {
            RakazoNotificationService.start(context)
        }
    }
}
