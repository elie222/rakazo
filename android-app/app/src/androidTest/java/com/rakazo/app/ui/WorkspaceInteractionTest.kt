package com.rakazo.app.ui

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.test.assertHasClickAction
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.longClick
import androidx.compose.ui.test.swipeLeft
import androidx.compose.runtime.mutableStateOf
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

    @Test
    fun longPressAndSwipeOpenChatOptions() {
        var optionRequests = 0
        compose.setContent {
            RakazoTheme {
                WorkspaceScreen(
                    agents = listOf(Agent("maya", "Maya", "Chief of Staff", Color.Cyan)),
                    onOpenAgent = {},
                    onOrganizeAgent = { optionRequests += 1 },
                )
            }
        }

        compose.onNodeWithText("Maya").performTouchInput { longClick() }
        compose.runOnIdle { assertEquals(1, optionRequests) }
        compose.onNodeWithText("Maya").performTouchInput { swipeLeft() }
        compose.runOnIdle { assertEquals(2, optionRequests) }
    }

    @Test
    fun agentPreviewUpdatesWhenTheWorkspaceSnapshotRefreshes() {
        val agents = mutableStateOf(listOf(Agent("maya", "Maya", "Old Gmail task", Color.Cyan)))
        compose.setContent {
            RakazoTheme {
                WorkspaceScreen(agents = agents.value, onOpenAgent = {})
            }
        }

        compose.onNodeWithText("Old Gmail task").assertExists()
        compose.runOnIdle { agents.value = listOf(Agent("maya", "Maya", "Hi", Color.Cyan)) }
        compose.onNodeWithText("Hi").assertExists()
    }

    @Test
    fun unreadIndicatorUsesUnreadStateInsteadOfPinnedState() {
        compose.setContent {
            RakazoTheme {
                WorkspaceScreen(
                    agents = listOf(
                        Agent("maya", "Maya", "Read", Color.Cyan, pinned = true, unread = false),
                        Agent("github", "GitHub", "Unread", Color.Yellow, unread = true),
                    ),
                    onOpenAgent = {},
                )
            }
        }

        compose.onAllNodesWithContentDescription("Unread").assertCountEquals(1)
    }

    @Test
    fun workspaceToolbarOpensSearchActivityAndCreate() {
        compose.setContent {
            RakazoTheme {
                WorkspaceScreen(
                    agents = emptyList(),
                    onOpenAgent = {},
                    onCreateAgent = { _, _, _ -> },
                )
            }
        }

        compose.onNodeWithContentDescription("Search").performClick()
        compose.onNodeWithText("Search conversations, files, and routines").assertExists()
        compose.onNodeWithContentDescription("Activity").performClick()
        compose.onNodeWithText("No activity yet").assertExists()
        compose.onNodeWithContentDescription("New agent").performClick()
        compose.onNodeWithText("New agent").assertExists()
    }
}
