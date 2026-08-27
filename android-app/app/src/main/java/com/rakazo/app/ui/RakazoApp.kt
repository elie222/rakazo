package com.rakazo.app.ui

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.ArrowUpward
import androidx.compose.material.icons.outlined.Call
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.ChevronRight
import androidx.compose.material.icons.outlined.DesktopWindows
import androidx.compose.material.icons.outlined.Hub
import androidx.compose.material.icons.outlined.MicNone
import androidx.compose.material.icons.outlined.MoreVert
import androidx.compose.material.icons.outlined.NotificationsNone
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material.icons.outlined.TouchApp
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.rakazo.app.ui.theme.Border
import com.rakazo.app.ui.theme.BorderStrong
import com.rakazo.app.ui.theme.Cream
import com.rakazo.app.ui.theme.CreamText
import com.rakazo.app.ui.theme.Elevated
import com.rakazo.app.ui.theme.FocusBlue
import com.rakazo.app.ui.theme.Page
import com.rakazo.app.ui.theme.RakazoTheme
import com.rakazo.app.ui.theme.Success
import com.rakazo.app.ui.theme.Surface as SurfaceColor
import com.rakazo.app.ui.theme.TextMuted
import com.rakazo.app.ui.theme.TextPrimary
import com.rakazo.app.ui.theme.TextSecondary
import com.rakazo.app.ui.theme.UnreadPurple

private enum class AppScreen { Workspace, Thread, Computer }
private enum class WorkspaceMode { Agents, Activity }

private data class Agent(
    val id: String,
    val name: String,
    val summary: String,
    val color: Color,
)

private data class ActivityItem(
    val agent: Agent,
    val summary: String,
    val time: String,
)

private val Maya = Agent("maya", "Maya", "Here are three researched options…", Color(0xFF45D8BB))

private val Agents = listOf(
    Maya,
    Agent("github", "GitHub", "Local CLI ready", Color(0xFFFFA62E)),
    Agent("x-writer", "X Writer", "Drafting three variants", Color(0xFF4DD6BE)),
    Agent("research", "Research", "Research Analyst", Color(0xFF3478F6)),
    Agent("gmail", "Gmail", "Gmail Specialist", Color(0xFF7567F7)),
    Agent("health", "Health", "Health Tracking Specialist", Color(0xFFE84D8A)),
    Agent("calendar", "Calendar", "Google Calendar Specialist", Color(0xFF9B4DF2)),
    Agent("home", "Home", "Home Assistant Operator", Color(0xFFFF651A)),
)

private val RecentActivity = listOf(
    ActivityItem(Maya, "Researched launch positioning and delegated copy", "11m ago"),
    ActivityItem(Agents[1], "Checked repository status and release notes", "14m ago"),
    ActivityItem(Agents[3], "Compared three Android motion libraries", "28m ago"),
    ActivityItem(Agents[6], "Prepared tomorrow’s planning block", "1h ago"),
    ActivityItem(Agents[4], "Summarized the latest project thread", "2h ago"),
    ActivityItem(Agents[5], "Updated today’s activity summary", "3h ago"),
)

@Composable
fun RakazoApp() {
    var screen by rememberSaveable { mutableStateOf(AppScreen.Workspace) }
    BackHandler(enabled = screen != AppScreen.Workspace) {
        screen = if (screen == AppScreen.Computer) AppScreen.Thread else AppScreen.Workspace
    }

    Surface(modifier = Modifier.fillMaxSize(), color = Page) {
        AnimatedContent(
            targetState = screen,
            transitionSpec = {
                val direction = if (targetState.ordinal > initialState.ordinal) 1 else -1
                (slideInHorizontally(tween(220)) { it / 12 * direction } + fadeIn(tween(180)))
                    .togetherWith(
                        slideOutHorizontally(tween(180)) { -it / 16 * direction } + fadeOut(tween(140)),
                    )
            },
            label = "Rakazo screen",
        ) { destination ->
            when (destination) {
                AppScreen.Workspace -> WorkspaceScreen(onOpenMaya = { screen = AppScreen.Thread })
                AppScreen.Thread -> ThreadScreen(
                    onBack = { screen = AppScreen.Workspace },
                    onOpenComputer = { screen = AppScreen.Computer },
                )
                AppScreen.Computer -> ComputerScreen(onBack = { screen = AppScreen.Thread })
            }
        }
    }
}

@Composable
private fun WorkspaceScreen(onOpenMaya: () -> Unit) {
    var mode by rememberSaveable { mutableStateOf(WorkspaceMode.Agents) }
    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(Page)
            .statusBarsPadding(),
    ) {
        WorkspaceAppBar()
        WorkspaceTabs(mode = mode, onModeChange = { mode = it })
        HorizontalDivider(color = Border)
        AnimatedContent(
            targetState = mode,
            transitionSpec = {
                fadeIn(tween(180)).togetherWith(fadeOut(tween(120)))
            },
            modifier = Modifier.weight(1f),
            label = "Workspace mode",
        ) { selected ->
            when (selected) {
                WorkspaceMode.Agents -> AgentList(onOpenMaya)
                WorkspaceMode.Activity -> ActivityList()
            }
        }
    }
}

@Composable
private fun WorkspaceAppBar() {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(72.dp)
            .padding(horizontal = 20.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text("Rakazo", style = MaterialTheme.typography.headlineMedium)
        Spacer(Modifier.weight(1f))
        AppBarIcon(Icons.Outlined.NotificationsNone, "Activity")
        AppBarIcon(Icons.Outlined.Search, "Search")
        AppBarIcon(Icons.Outlined.Add, "New agent")
        Surface(
            modifier = Modifier.size(44.dp),
            shape = CircleShape,
            color = Elevated,
        ) {
            Box(contentAlignment = Alignment.Center) {
                Text("L", color = TextSecondary, fontWeight = FontWeight.Medium)
            }
        }
    }
}

@Composable
private fun AppBarIcon(icon: ImageVector, description: String) {
    IconButton(onClick = {}, modifier = Modifier.size(48.dp)) {
        Icon(icon, description, tint = TextSecondary)
    }
}

@Composable
private fun WorkspaceTabs(mode: WorkspaceMode, onModeChange: (WorkspaceMode) -> Unit) {
    Row(modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp)) {
        WorkspaceMode.entries.forEach { item ->
            val selected = mode == item
            Column(
                modifier = Modifier
                    .clickable { onModeChange(item) }
                    .padding(horizontal = 12.dp, vertical = 12.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Text(
                    text = item.name,
                    color = if (selected) TextPrimary else TextMuted,
                    fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Medium,
                )
                Spacer(Modifier.height(9.dp))
                Box(
                    Modifier
                        .height(2.dp)
                        .width(72.dp)
                        .background(if (selected) FocusBlue else Color.Transparent),
                )
            }
        }
    }
}

@Composable
private fun AgentList(onOpenMaya: () -> Unit) {
    var query by rememberSaveable { mutableStateOf("") }
    val visible = remember(query) {
        Agents.filter { agent ->
            query.isBlank() || agent.name.contains(query, ignoreCase = true) ||
                agent.summary.contains(query, ignoreCase = true)
        }
    }

    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(bottom = 28.dp),
    ) {
        item {
            SearchField(query = query, onQueryChange = { query = it })
        }
        if (Maya in visible) {
            item { SectionLabel("Pinned") }
            item {
                AgentRow(agent = Maya, pinned = true, onClick = onOpenMaya)
            }
        }
        val unassigned = visible.filterNot { it == Maya }
        if (unassigned.isNotEmpty()) {
            item { SectionLabel("Unassigned") }
            items(unassigned, key = { it.id }) { agent ->
                AgentRow(agent = agent, onClick = if (agent.id == "maya") onOpenMaya else ({}))
            }
        }
    }
}

@Composable
private fun SearchField(query: String, onQueryChange: (String) -> Unit) {
    Surface(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 16.dp),
        shape = RoundedCornerShape(16.dp),
        color = SurfaceColor,
        border = androidx.compose.foundation.BorderStroke(1.dp, Border),
    ) {
        Row(
            modifier = Modifier.height(56.dp).padding(horizontal = 16.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(Icons.Outlined.Search, null, tint = TextMuted)
            Spacer(Modifier.width(12.dp))
            BasicTextField(
                value = query,
                onValueChange = onQueryChange,
                modifier = Modifier.weight(1f),
                singleLine = true,
                textStyle = MaterialTheme.typography.bodyLarge.copy(color = TextPrimary),
                decorationBox = { field ->
                    if (query.isEmpty()) Text("Search agents", color = TextMuted)
                    field()
                },
            )
        }
    }
}

@Composable
private fun SectionLabel(text: String) {
    Text(
        text = text,
        modifier = Modifier.padding(start = 20.dp, top = 20.dp, bottom = 10.dp),
        style = MaterialTheme.typography.bodyMedium,
        color = TextMuted,
        fontWeight = FontWeight.Medium,
    )
}

@Composable
private fun AgentRow(agent: Agent, pinned: Boolean = false, onClick: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 20.dp, vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        OrganicAvatar(agent.id, agent.color, size = 54.dp)
        Spacer(Modifier.width(16.dp))
        Column(Modifier.weight(1f)) {
            Text(agent.name, style = MaterialTheme.typography.titleMedium)
            Spacer(Modifier.height(3.dp))
            Text(
                agent.summary,
                color = TextSecondary,
                style = MaterialTheme.typography.bodyMedium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        if (pinned) {
            Box(Modifier.size(8.dp).clip(CircleShape).background(UnreadPurple))
            Spacer(Modifier.width(18.dp))
            Text("Now", color = TextMuted, style = MaterialTheme.typography.bodyMedium)
        } else {
            Icon(Icons.Outlined.ChevronRight, null, tint = TextMuted)
        }
    }
    HorizontalDivider(modifier = Modifier.padding(start = 90.dp), color = Border)
}

@Composable
private fun ActivityList() {
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(bottom = 28.dp),
    ) {
        item { SectionLabel("Now") }
        item {
            ActivityRow(
                agent = Agents[2],
                summary = "Drafting three launch variants",
                time = "Running",
                running = true,
            )
        }
        item { SectionLabel("Recent") }
        items(RecentActivity, key = { it.agent.id }) { activity ->
            ActivityRow(activity.agent, activity.summary, activity.time)
        }
    }
}

@Composable
private fun ActivityRow(agent: Agent, summary: String, time: String, running: Boolean = false) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 15.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        OrganicAvatar(agent.id, agent.color, size = 50.dp, working = running)
        Spacer(Modifier.width(16.dp))
        Column(Modifier.weight(1f)) {
            Text(agent.name, style = MaterialTheme.typography.titleMedium)
            Spacer(Modifier.height(3.dp))
            Text(
                summary,
                color = TextSecondary,
                style = MaterialTheme.typography.bodyMedium,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        }
        Spacer(Modifier.width(12.dp))
        Column(horizontalAlignment = Alignment.End) {
            Text(time, color = if (running) FocusBlue else TextMuted, style = MaterialTheme.typography.bodyMedium)
            if (!running) {
                Spacer(Modifier.height(5.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.size(7.dp).clip(CircleShape).background(Success))
                    Spacer(Modifier.width(6.dp))
                    Text("Done", color = Success, style = MaterialTheme.typography.bodyMedium)
                }
            }
        }
    }
    HorizontalDivider(modifier = Modifier.padding(start = 86.dp), color = Border)
}

@Composable
private fun ThreadScreen(onBack: () -> Unit, onOpenComputer: () -> Unit) {
    val sentMessages = remember { mutableStateListOf<String>() }
    var draft by rememberSaveable { mutableStateOf("") }
    Column(
        modifier = Modifier.fillMaxSize().background(Page).statusBarsPadding(),
    ) {
        AgentTopBar(onBack = onBack, onOpenComputer = onOpenComputer)
        HorizontalDivider(color = Border)
        LazyColumn(
            modifier = Modifier.weight(1f),
            contentPadding = PaddingValues(horizontal = 20.dp, vertical = 20.dp),
            verticalArrangement = Arrangement.spacedBy(20.dp),
        ) {
            item { UserBubble("Rewrite this into a concise launch post.") }
            item { ThreadEvent("Messaged X Writer") }
            item {
                SemanticCard(title = "Message bot", checked = true) {
                    Text(
                        "I’ve sent it to X Writer to verify the link and claims.",
                        color = TextPrimary,
                        style = MaterialTheme.typography.bodyLarge,
                    )
                }
            }
            item { ThreadEvent("Message from GitHub") }
            item {
                SemanticCard {
                    Text(
                        "No new action is needed from GitHub. I’m still waiting on X Writer.",
                        color = TextPrimary,
                        style = MaterialTheme.typography.bodyLarge,
                    )
                }
            }
            item { ThreadEvent("Message from X Writer") }
            item {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text("Here are three polished options:", style = MaterialTheme.typography.bodyLarge)
                    Text("1.  Rakazo gives every task the right specialist.", color = TextSecondary)
                    Text("2.  One workspace. A team of focused agents.", color = TextSecondary)
                    Text("3.  Delegate the work, keep the control.", color = TextSecondary)
                }
            }
            items(sentMessages) { message -> UserBubble(message) }
        }
        HorizontalDivider(color = Border)
        Composer(
            value = draft,
            onValueChange = { draft = it },
            onSend = {
                if (draft.isNotBlank()) {
                    sentMessages += draft.trim()
                    draft = ""
                }
            },
        )
    }
}

@Composable
private fun AgentTopBar(onBack: () -> Unit, onOpenComputer: () -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth().height(76.dp).padding(horizontal = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        IconButton(onClick = onBack) {
            Icon(Icons.AutoMirrored.Outlined.ArrowBack, "Back", tint = TextSecondary)
        }
        OrganicAvatar(Maya.id, Maya.color, size = 44.dp, working = true)
        Spacer(Modifier.width(12.dp))
        Column {
            Text("Maya", style = MaterialTheme.typography.titleLarge)
            Text("Working", color = TextMuted, style = MaterialTheme.typography.bodyMedium)
        }
        Spacer(Modifier.weight(1f))
        IconButton(onClick = {}) { Icon(Icons.Outlined.Call, "Start voice call", tint = TextSecondary) }
        IconButton(onClick = onOpenComputer) {
            Icon(Icons.Outlined.DesktopWindows, "Open Maya’s computer", tint = TextSecondary)
        }
    }
}

@Composable
private fun UserBubble(text: String) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
        Surface(
            modifier = Modifier.widthIn(max = 310.dp),
            shape = RoundedCornerShape(18.dp),
            color = Cream,
        ) {
            Text(
                text,
                modifier = Modifier.padding(horizontal = 18.dp, vertical = 14.dp),
                color = CreamText,
                style = MaterialTheme.typography.bodyLarge,
            )
        }
    }
}

@Composable
private fun ThreadEvent(text: String) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Icon(Icons.Outlined.Hub, null, tint = TextMuted, modifier = Modifier.size(20.dp))
        Spacer(Modifier.width(12.dp))
        Text(text, color = TextMuted, style = MaterialTheme.typography.bodyMedium)
    }
}

@Composable
private fun SemanticCard(
    title: String? = null,
    checked: Boolean = false,
    content: @Composable () -> Unit,
) {
    Surface(
        modifier = Modifier.fillMaxWidth().padding(start = 32.dp),
        shape = RoundedCornerShape(14.dp),
        color = SurfaceColor,
        border = androidx.compose.foundation.BorderStroke(1.dp, BorderStrong),
    ) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            if (title != null) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    if (checked) {
                        Icon(Icons.Outlined.Check, null, tint = Success, modifier = Modifier.size(20.dp))
                        Spacer(Modifier.width(10.dp))
                    }
                    Text(title, color = TextSecondary, style = MaterialTheme.typography.titleMedium)
                }
            }
            content()
        }
    }
}

@Composable
private fun Composer(value: String, onValueChange: (String) -> Unit, onSend: () -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth().navigationBarsPadding().padding(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        CircleIconButton(Icons.Outlined.Add, "Attach") {}
        Spacer(Modifier.width(8.dp))
        Surface(
            modifier = Modifier.weight(1f),
            shape = RoundedCornerShape(28.dp),
            color = SurfaceColor,
            border = androidx.compose.foundation.BorderStroke(1.dp, BorderStrong),
        ) {
            Row(
                modifier = Modifier.height(54.dp).padding(start = 18.dp, end = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                BasicTextField(
                    value = value,
                    onValueChange = onValueChange,
                    modifier = Modifier.weight(1f),
                    singleLine = true,
                    textStyle = MaterialTheme.typography.bodyLarge.copy(color = TextPrimary),
                    decorationBox = { field ->
                        if (value.isEmpty()) Text("Message Maya", color = TextMuted)
                        field()
                    },
                )
                IconButton(onClick = {}) { Icon(Icons.Outlined.MicNone, "Voice message", tint = TextMuted) }
            }
        }
        Spacer(Modifier.width(8.dp))
        Surface(
            modifier = Modifier.size(54.dp).clickable(onClick = onSend),
            shape = CircleShape,
            color = Cream,
        ) {
            Box(contentAlignment = Alignment.Center) {
                Icon(Icons.Outlined.ArrowUpward, "Send", tint = CreamText)
            }
        }
    }
}

@Composable
private fun CircleIconButton(icon: ImageVector, description: String, onClick: () -> Unit) {
    Surface(
        modifier = Modifier.size(48.dp).clickable(onClick = onClick),
        shape = CircleShape,
        color = Color.Transparent,
        border = androidx.compose.foundation.BorderStroke(1.dp, BorderStrong),
    ) {
        Box(contentAlignment = Alignment.Center) {
            Icon(icon, description, tint = TextSecondary)
        }
    }
}

@Composable
private fun ComputerScreen(onBack: () -> Unit) {
    var controlling by rememberSaveable { mutableStateOf(true) }
    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(Page)
            .statusBarsPadding()
            .navigationBarsPadding(),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth().height(76.dp).padding(horizontal = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconButton(onClick = onBack) {
                Icon(Icons.AutoMirrored.Outlined.ArrowBack, "Back", tint = TextSecondary)
            }
            OrganicAvatar(Maya.id, Maya.color, size = 42.dp)
            Spacer(Modifier.width(12.dp))
            Column {
                Text("Maya’s computer", style = MaterialTheme.typography.titleLarge)
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.size(7.dp).clip(CircleShape).background(Success))
                    Spacer(Modifier.width(7.dp))
                    Text("Connected", color = TextMuted, style = MaterialTheme.typography.bodyMedium)
                }
            }
            Spacer(Modifier.weight(1f))
            IconButton(onClick = {}) { Icon(Icons.Outlined.MoreVert, "More options", tint = TextSecondary) }
        }

        ComputerModeTabs()
        RemoteScreenPreview(modifier = Modifier.padding(horizontal = 16.dp, vertical = 14.dp))
        Surface(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp),
            shape = RoundedCornerShape(12.dp),
            color = SurfaceColor,
        ) {
            Row(
                modifier = Modifier.padding(horizontal = 14.dp, vertical = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(Icons.Outlined.TouchApp, null, tint = FocusBlue)
                Spacer(Modifier.width(10.dp))
                Text(
                    if (controlling) "You’re controlling Maya’s computer" else "Maya has control",
                    modifier = Modifier.weight(1f),
                    color = TextSecondary,
                    style = MaterialTheme.typography.bodyMedium,
                )
                Text(
                    if (controlling) "LIVE" else "READY",
                    color = FocusBlue,
                    fontFamily = FontFamily.Monospace,
                    fontSize = 11.sp,
                )
            }
        }

        Spacer(Modifier.height(18.dp))
        AnimatedVisibility(visible = controlling) {
            Text(
                "Maya is waiting while you control the computer.",
                modifier = Modifier.padding(horizontal = 16.dp),
                color = TextMuted,
                style = MaterialTheme.typography.bodyMedium,
            )
        }
        Spacer(Modifier.height(14.dp))
        Button(
            onClick = { controlling = !controlling },
            modifier = Modifier.padding(horizontal = 16.dp).fillMaxWidth().height(56.dp),
            shape = RoundedCornerShape(28.dp),
            colors = ButtonDefaults.buttonColors(containerColor = Cream, contentColor = CreamText),
        ) {
            Text(if (controlling) "Release control" else "Take control", fontWeight = FontWeight.SemiBold)
        }
        TextButton(
            onClick = {},
            modifier = Modifier.align(Alignment.CenterHorizontally),
        ) {
            Icon(Icons.Outlined.Refresh, null, tint = TextSecondary, modifier = Modifier.size(18.dp))
            Spacer(Modifier.width(8.dp))
            Text("Reconnect", color = TextSecondary)
        }
        Spacer(Modifier.weight(1f))
        Surface(
            modifier = Modifier.fillMaxWidth().padding(16.dp),
            shape = RoundedCornerShape(12.dp),
            color = SurfaceColor,
        ) {
            Row(
                modifier = Modifier.clickable {}.padding(horizontal = 16.dp, vertical = 17.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text("Routines", modifier = Modifier.weight(1f), color = TextSecondary)
                Text("0", color = TextMuted, style = MaterialTheme.typography.labelMedium)
                Spacer(Modifier.width(12.dp))
                Icon(Icons.Outlined.ChevronRight, null, tint = TextMuted)
            }
        }
    }
}

@Composable
private fun ComputerModeTabs() {
    Surface(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp),
        shape = RoundedCornerShape(12.dp),
        color = SurfaceColor,
    ) {
        Row(Modifier.fillMaxWidth()) {
            listOf("Team computer" to true, "Dedicated" to false).forEach { (label, selected) ->
                Column(
                    modifier = Modifier.weight(1f).padding(top = 14.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Text(label, color = if (selected) FocusBlue else TextMuted)
                    Spacer(Modifier.height(12.dp))
                    Box(
                        Modifier.fillMaxWidth().height(2.dp)
                            .background(if (selected) FocusBlue else Color.Transparent),
                    )
                }
            }
        }
    }
}

@Composable
private fun RemoteScreenPreview(modifier: Modifier = Modifier) {
    Surface(
        modifier = modifier.fillMaxWidth().aspectRatio(16f / 10f),
        shape = RoundedCornerShape(12.dp),
        color = Color(0xFFF4F5F7),
    ) {
        Column {
            Row(
                modifier = Modifier.fillMaxWidth().height(34.dp).background(Color(0xFFE7E9ED)).padding(horizontal = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Box(Modifier.size(7.dp).clip(CircleShape).background(Color(0xFFFF6B62)))
                Spacer(Modifier.width(5.dp))
                Box(Modifier.size(7.dp).clip(CircleShape).background(Color(0xFFFFC14F)))
                Spacer(Modifier.width(5.dp))
                Box(Modifier.size(7.dp).clip(CircleShape).background(Color(0xFF46C96B)))
                Spacer(Modifier.width(12.dp))
                Surface(
                    modifier = Modifier.height(20.dp).weight(1f),
                    shape = RoundedCornerShape(10.dp),
                    color = Color.White,
                ) {
                    Box(contentAlignment = Alignment.CenterStart) {
                        Text(
                            "  rakazo.local/workspace",
                            color = Color(0xFF72757D),
                            fontSize = 8.sp,
                        )
                    }
                }
            }
            Column(Modifier.fillMaxSize().padding(18.dp)) {
                Text("Project hub", color = Color(0xFF17171A), fontWeight = FontWeight.SemiBold, fontSize = 18.sp)
                Spacer(Modifier.height(4.dp))
                Text("Three active workstreams", color = Color(0xFF72757D), fontSize = 10.sp)
                Spacer(Modifier.height(16.dp))
                listOf("Agent integration", "Knowledge base", "Automation scripts").forEachIndexed { index, title ->
                    Surface(
                        modifier = Modifier.fillMaxWidth().padding(bottom = 8.dp),
                        shape = RoundedCornerShape(8.dp),
                        color = Color.White,
                        border = androidx.compose.foundation.BorderStroke(1.dp, Color(0xFFE1E2E5)),
                    ) {
                        Row(
                            modifier = Modifier.padding(horizontal = 12.dp, vertical = 10.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Box(
                                Modifier.size(22.dp).clip(RoundedCornerShape(6.dp))
                                    .background(listOf(Color(0xFFDCEBFF), Color(0xFFDDF5EA), Color(0xFFEDE3FF))[index]),
                            )
                            Spacer(Modifier.width(10.dp))
                            Text(title, color = Color(0xFF24252A), fontSize = 10.sp)
                        }
                    }
                }
            }
        }
    }
}

@Preview(showBackground = true, widthDp = 393, heightDp = 852)
@Composable
private fun RakazoPreview() {
    RakazoTheme { RakazoApp() }
}
