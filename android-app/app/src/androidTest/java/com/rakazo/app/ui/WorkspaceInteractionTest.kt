package com.rakazo.app.ui

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.test.assertHasClickAction
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.rakazo.app.ui.theme.RakazoTheme
import org.junit.Assert.assertFalse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class WorkspaceInteractionTest {
    @get:Rule
    val compose = createComposeRule()

    @Test
    fun agentRowOpensItsThread() {
        var openedAgentId: String? = null
        compose.setContent {
            RakazoTheme {
                WorkspaceScreen(
                    agents = listOf(Agent("maya", "Maya", "Chief of Staff", Color.Cyan)),
                    onOpenAgent = { openedAgentId = it.id },
                )
            }
        }

        compose.onNodeWithText("Maya").assertHasClickAction().performClick()
        assertEquals("maya", openedAgentId)
    }

    @Test
    fun accountButtonDoesNotSignOutImmediately() {
        var signedOut = false
        compose.setContent {
            RakazoTheme {
                WorkspaceScreen(
                    agents = emptyList(),
                    onOpenAgent = {},
                    onSignOut = { signedOut = true },
                )
            }
        }

        compose.onNodeWithContentDescription("Account").performClick()
        assertFalse(signedOut)
        compose.onNodeWithText("Sign out").assertHasClickAction().performClick()
        assertTrue(signedOut)
    }
}
