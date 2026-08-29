package com.rakazo.app

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.rakazo.app.ui.RakazoApp
import com.rakazo.app.ui.theme.RakazoTheme

class MainActivity : ComponentActivity() {
    private var openBotId by mutableStateOf<String?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        openBotId = intent.getStringExtra(EXTRA_BOT_ID)
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.dark(android.graphics.Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.dark(android.graphics.Color.TRANSPARENT),
        )
        setContent {
            RakazoTheme {
                RakazoApp(openBotId = openBotId, onOpenBotConsumed = { openBotId = null })
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        openBotId = intent.getStringExtra(EXTRA_BOT_ID)
    }

    companion object {
        const val EXTRA_BOT_ID = "com.rakazo.app.BOT_ID"
    }
}
