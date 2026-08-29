package com.rakazo.app.ui

import android.graphics.Color.parseColor
import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.slideOutVertically
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.ArrowUpward
import androidx.compose.material.icons.outlined.ArrowDownward
import androidx.compose.material.icons.outlined.Call
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.ChevronRight
import androidx.compose.material.icons.outlined.DesktopWindows
import androidx.compose.material.icons.outlined.CreateNewFolder
import androidx.compose.material.icons.outlined.Folder
import androidx.compose.material.icons.outlined.Hub
import androidx.compose.material.icons.outlined.MicNone
import androidx.compose.material.icons.outlined.MoreVert
import androidx.compose.material.icons.outlined.NotificationsNone
import androidx.compose.material.icons.outlined.Person
import androidx.compose.material.icons.outlined.PushPin
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material.icons.outlined.TouchApp
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Surface
import androidx.compose.material3.SwipeToDismissBox
import androidx.compose.material3.SwipeToDismissBoxValue
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberSwipeToDismissBoxState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
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
import com.rakazo.app.network.AgentRecord
import com.rakazo.app.network.BotSectionRecord
import com.rakazo.app.network.AndroidSessionStore
import com.rakazo.app.network.ApiException
import com.rakazo.app.network.EndpointResult
import com.rakazo.app.network.RakazoApi
import com.rakazo.app.network.SessionManager
import com.rakazo.app.network.MessageBlockRecord
import com.rakazo.app.network.ThreadMessageRecord
import com.rakazo.app.network.ThreadSnapshotRecord
import com.rakazo.app.network.normalizeEndpoint
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.IOException

private enum class AppScreen { Workspace, Thread, Computer }
private enum class WorkspaceMode { Agents, Activity }
private val ACTIVE_RUN_STATUSES = setOf("queued", "leased", "running", "waiting_input", "waiting_takeover")
private val POLLING_RUN_STATUSES = setOf("queued", "leased", "running")

internal data class Agent(
    val id: String,
    val name: String,
    val summary: String,
    val color: Color,
    val pinned: Boolean = false,
    val status: String = "",
    val sectionId: String? = null,
)

internal data class AgentSection(val id: String, val name: String)

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

private sealed interface RuntimeState {
    data object Starting : RuntimeState
    data class Server(val draft: String = "", val error: String? = null, val pending: Boolean = false) : RuntimeState
    data class SignIn(val endpoint: String, val error: String? = null, val pending: Boolean = false) : RuntimeState
    data class Workspace(val agents: List<Agent>, val sections: List<AgentSection>) : RuntimeState
    data class Offline(val message: String) : RuntimeState
    data object Expired : RuntimeState
}

@Composable
fun RakazoApp() {
    val context = LocalContext.current.applicationContext
    val api = remember { RakazoApi() }
    val session = remember { SessionManager(AndroidSessionStore(context)) }
    val scope = rememberCoroutineScope()
    var state: RuntimeState by remember { mutableStateOf(RuntimeState.Starting) }

    fun loadAgents() {
        state = RuntimeState.Starting
        scope.launch {
            state = try {
                val workspace = withContext(Dispatchers.IO) {
                    api.agents(session.endpoint, session.token) to api.sections(session.endpoint, session.token)
                }
                RuntimeState.Workspace(
                    workspace.first.map(AgentRecord::toAgent),
                    workspace.second.map(BotSectionRecord::toAgentSection),
                )
            } catch (error: ApiException) {
                if (error.status == 401) {
                    session.signedOut()
                    RuntimeState.Expired
                } else {
                    RuntimeState.Offline(error.message ?: "Could not load agents")
                }
            } catch (error: IOException) {
                RuntimeState.Offline("Could not reach the server")
            }
        }
    }

    LaunchedEffect(Unit) {
        state = when {
            session.endpoint.isEmpty() -> RuntimeState.Server()
            session.token.isEmpty() -> RuntimeState.SignIn(session.endpoint)
            else -> {
                loadAgents()
                RuntimeState.Starting
            }
        }
    }

    Surface(modifier = Modifier.fillMaxSize(), color = Page) {
        when (val current = state) {
            RuntimeState.Starting -> LoadingScreen()
            is RuntimeState.Server -> ServerScreen(current) { input ->
                when (val endpoint = normalizeEndpoint(input)) {
                    is EndpointResult.Invalid -> state = current.copy(error = endpoint.message)
                    is EndpointResult.Valid -> {
                        state = current.copy(error = null, pending = true)
                        scope.launch {
                            state = try {
                                withContext(Dispatchers.IO) { api.probe(endpoint.url) }
                                session.useEndpoint(endpoint.url)
                                RuntimeState.SignIn(endpoint.url)
                            } catch (error: IOException) {
                                current.copy(error = error.message ?: "Could not reach that server")
                            }
                        }
                    }
                }
            }
            is RuntimeState.SignIn -> SignInScreen(
                state = current,
                onChangeServer = { state = RuntimeState.Server(current.endpoint) },
                onSubmit = { email, password ->
                    if (email.isBlank() || password.isEmpty()) {
                        state = current.copy(error = "Enter your email and password")
                    } else {
                        state = current.copy(error = null, pending = true)
                        scope.launch {
                            try {
                                val token = withContext(Dispatchers.IO) {
                                    api.signIn(current.endpoint, email.trim(), password)
                                }
                                session.signedIn(token)
                                loadAgents()
                            } catch (error: IOException) {
                                state = current.copy(error = error.message ?: "Could not sign in")
                            }
                        }
                    }
                },
            )
            is RuntimeState.Workspace -> LiveWorkspace(
                agents = current.agents,
                sections = current.sections,
                refreshWorkspace = {
                    withContext(Dispatchers.IO) {
                        api.agents(session.endpoint, session.token).map(AgentRecord::toAgent) to
                            api.sections(session.endpoint, session.token).map(BotSectionRecord::toAgentSection)
                    }
                },
                setAgentPinned = { botId, pinned ->
                    withContext(Dispatchers.IO) {
                        api.setAgentPinned(session.endpoint, session.token, botId, pinned).toAgent()
                    }
                },
                moveAgentToSection = { botId, sectionId ->
                    withContext(Dispatchers.IO) {
                        api.moveAgentToSection(session.endpoint, session.token, botId, sectionId).toAgent()
                    }
                },
                createSection = { botId, name ->
                    withContext(Dispatchers.IO) {
                        api.createSection(session.endpoint, session.token, botId, name).toAgentSection()
                    }
                },
                loadThread = { botId ->
                    withContext(Dispatchers.IO) { api.thread(session.endpoint, session.token, botId) }
                },
                sendMessage = { botId, message ->
                    withContext(Dispatchers.IO) { api.sendMessage(session.endpoint, session.token, botId, message) }
                },
                onSessionExpired = {
                    session.signedOut()
                    state = RuntimeState.Expired
                },
                onSignOut = {
                    val endpoint = session.endpoint
                    val token = session.token
                    session.signedOut()
                    state = RuntimeState.SignIn(endpoint)
                    scope.launch(Dispatchers.IO) { runCatching { api.signOut(endpoint, token) } }
                },
            )
            is RuntimeState.Offline -> StatusScreen(
                title = "Rakazo is offline",
                message = current.message,
                action = "Retry",
                onAction = ::loadAgents,
                secondaryAction = "Sign out",
                onSecondaryAction = {
                    session.signedOut()
                    state = RuntimeState.SignIn(session.endpoint)
                },
            )
            RuntimeState.Expired -> StatusScreen(
                title = "Session expired",
                message = "Sign in again to continue.",
                action = "Sign in",
                onAction = { state = RuntimeState.SignIn(session.endpoint) },
            )
        }
    }
}

@Composable
private fun LiveWorkspace(
    agents: List<Agent>,
    sections: List<AgentSection>,
    refreshWorkspace: suspend () -> Pair<List<Agent>, List<AgentSection>>,
    setAgentPinned: suspend (String, Boolean) -> Agent,
    moveAgentToSection: suspend (String, String?) -> Agent,
    createSection: suspend (String, String) -> AgentSection,
    loadThread: suspend (String) -> ThreadSnapshotRecord,
    sendMessage: suspend (String, String) -> Unit,
    onSessionExpired: () -> Unit,
    onSignOut: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    var selectedAgentId by rememberSaveable { mutableStateOf<String?>(null) }
    var liveAgents by remember(agents) { mutableStateOf(agents) }
    var liveSections by remember(sections) { mutableStateOf(sections) }
    var organizeAgentId by rememberSaveable { mutableStateOf<String?>(null) }
    val selectedAgent = liveAgents.firstOrNull { it.id == selectedAgentId }
    val organizeAgent = liveAgents.firstOrNull { it.id == organizeAgentId }

    fun handleWorkspaceError(error: IOException) {
        if (error is ApiException && error.status == 401) onSessionExpired()
    }

    fun closeThread() {
        selectedAgentId = null
        scope.launch {
            try {
                val refreshed = refreshWorkspace()
                liveAgents = refreshed.first
                liveSections = refreshed.second
            } catch (error: IOException) {
                handleWorkspaceError(error)
            }
        }
    }

    BackHandler(enabled = selectedAgent != null) { closeThread() }

    AnimatedContent(
        targetState = selectedAgent,
        transitionSpec = {
            val direction = if (targetState != null) 1 else -1
            (slideInHorizontally(tween(220)) { it / 12 * direction } + fadeIn(tween(180)))
                .togetherWith(
                    slideOutHorizontally(tween(180)) { -it / 16 * direction } + fadeOut(tween(140)),
                )
        },
        label = "Agent thread",
    ) { agent ->
        if (agent == null) {
            WorkspaceScreen(
                agents = liveAgents,
                sections = liveSections,
                onOpenAgent = { selectedAgentId = it.id },
                onOrganizeAgent = { organizeAgentId = it.id },
                onSignOut = onSignOut,
            )
        } else {
            LiveThreadScreen(
                agent = agent,
                onBack = ::closeThread,
                loadThread = loadThread,
                sendMessage = sendMessage,
                onSessionExpired = onSessionExpired,
            )
        }
    }

    if (organizeAgent != null) {
        AgentOrganizeSheet(
            agent = organizeAgent,
            sections = liveSections,
            onDismiss = { organizeAgentId = null },
            onSetPinned = { pinned ->
                val updated = setAgentPinned(organizeAgent.id, pinned)
                liveAgents = liveAgents.map { if (it.id == updated.id) updated else it }
            },
            onMoveToSection = { sectionId ->
                val updated = moveAgentToSection(organizeAgent.id, sectionId)
                liveAgents = liveAgents.map { if (it.id == updated.id) updated else it }
            },
            onCreateSection = { name ->
                val created = createSection(organizeAgent.id, name)
                liveSections = liveSections + created
                liveAgents = liveAgents.map {
                    if (it.id == organizeAgent.id) it.copy(sectionId = created.id) else it
                }
            },
            onSessionExpired = onSessionExpired,
        )
    }
}

private fun AgentRecord.toAgent() = Agent(
    id = id,
    name = name,
    summary = summary,
    color = Color(runCatching { parseColor(color) }.getOrDefault(0xFF7567F7.toInt())),
    pinned = pinned,
    status = status,
    sectionId = sectionId,
)

private fun BotSectionRecord.toAgentSection() = AgentSection(id, name)

@Composable
private fun LoadingScreen() {
    Box(
        modifier = Modifier.fillMaxSize().background(Page).statusBarsPadding().navigationBarsPadding(),
        contentAlignment = Alignment.Center,
    ) {
        CircularProgressIndicator(color = FocusBlue, strokeWidth = 2.dp)
    }
}

@Composable
private fun ServerScreen(state: RuntimeState.Server, onContinue: (String) -> Unit) {
    var draft by rememberSaveable(state.draft) { mutableStateOf(state.draft) }
    FormScreen(title = "Connect to Rakazo", subtitle = "Enter the address of your Rakazo server.") {
        FormField(
            value = draft,
            onValueChange = { draft = it },
            placeholder = "https://rakazo.example.com",
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
        )
        FormError(state.error)
        Button(
            onClick = { onContinue(draft) },
            enabled = !state.pending,
            modifier = Modifier.fillMaxWidth().height(56.dp),
            shape = RoundedCornerShape(28.dp),
            colors = ButtonDefaults.buttonColors(containerColor = Cream, contentColor = CreamText),
        ) {
            Text(if (state.pending) "Checking…" else "Continue", fontWeight = FontWeight.SemiBold)
        }
    }
}

@Composable
private fun SignInScreen(
    state: RuntimeState.SignIn,
    onChangeServer: () -> Unit,
    onSubmit: (String, String) -> Unit,
) {
    var email by rememberSaveable { mutableStateOf("") }
    var password by rememberSaveable { mutableStateOf("") }
    FormScreen(title = "Sign in to Rakazo", subtitle = URIHost(state.endpoint)) {
        FormField(
            value = email,
            onValueChange = { email = it },
            placeholder = "Email",
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email),
        )
        FormField(
            value = password,
            onValueChange = { password = it },
            placeholder = "Password",
            visualTransformation = PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
        )
        FormError(state.error)
        Button(
            onClick = { onSubmit(email, password) },
            enabled = !state.pending,
            modifier = Modifier.fillMaxWidth().height(56.dp),
            shape = RoundedCornerShape(28.dp),
            colors = ButtonDefaults.buttonColors(containerColor = Cream, contentColor = CreamText),
        ) {
            Text(if (state.pending) "Signing in…" else "Continue", fontWeight = FontWeight.SemiBold)
        }
        TextButton(onClick = onChangeServer, modifier = Modifier.align(Alignment.CenterHorizontally)) {
            Text("Change server", color = TextSecondary)
        }
    }
}

@Composable
private fun FormScreen(
    title: String,
    subtitle: String,
    content: @Composable ColumnScope.() -> Unit,
) {
    Column(
        modifier = Modifier.fillMaxSize().background(Page).statusBarsPadding().navigationBarsPadding()
            .padding(horizontal = 24.dp),
        verticalArrangement = Arrangement.Center,
    ) {
        Text(title, style = MaterialTheme.typography.headlineMedium)
        Spacer(Modifier.height(8.dp))
        Text(subtitle, color = TextMuted, style = MaterialTheme.typography.bodyMedium)
        Spacer(Modifier.height(28.dp))
        Column(verticalArrangement = Arrangement.spacedBy(12.dp), content = content)
    }
}

@Composable
private fun FormField(
    value: String,
    onValueChange: (String) -> Unit,
    placeholder: String,
    keyboardOptions: KeyboardOptions,
    visualTransformation: androidx.compose.ui.text.input.VisualTransformation = androidx.compose.ui.text.input.VisualTransformation.None,
) {
    Surface(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(16.dp),
        color = SurfaceColor,
        border = androidx.compose.foundation.BorderStroke(1.dp, Border),
    ) {
        BasicTextField(
            value = value,
            onValueChange = onValueChange,
            modifier = Modifier.fillMaxWidth().height(56.dp).padding(horizontal = 16.dp, vertical = 17.dp),
            singleLine = true,
            keyboardOptions = keyboardOptions,
            visualTransformation = visualTransformation,
            textStyle = MaterialTheme.typography.bodyLarge.copy(color = TextPrimary),
            decorationBox = { field ->
                if (value.isEmpty()) Text(placeholder, color = TextMuted)
                field()
            },
        )
    }
}

@Composable
private fun FormError(message: String?) {
    if (message != null) {
        Surface(
            modifier = Modifier.fillMaxWidth(),
            shape = RoundedCornerShape(14.dp),
            color = SurfaceColor,
            border = androidx.compose.foundation.BorderStroke(1.dp, BorderStrong),
        ) {
            Text(message, modifier = Modifier.padding(16.dp), color = Color(0xFFFF8A8A))
        }
    }
}

@Composable
private fun StatusScreen(
    title: String,
    message: String,
    action: String,
    onAction: () -> Unit,
    secondaryAction: String? = null,
    onSecondaryAction: (() -> Unit)? = null,
) {
    FormScreen(title, message) {
        Button(
            onClick = onAction,
            modifier = Modifier.fillMaxWidth().height(56.dp),
            shape = RoundedCornerShape(28.dp),
            colors = ButtonDefaults.buttonColors(containerColor = Cream, contentColor = CreamText),
        ) { Text(action, fontWeight = FontWeight.SemiBold) }
        if (secondaryAction != null && onSecondaryAction != null) {
            TextButton(onClick = onSecondaryAction, modifier = Modifier.align(Alignment.CenterHorizontally)) {
                Text(secondaryAction, color = TextSecondary)
            }
        }
    }
}

private fun URIHost(endpoint: String) = runCatching { java.net.URI(endpoint).authority }.getOrNull() ?: endpoint

@Composable
private fun DemoRakazoApp() {
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
                AppScreen.Workspace -> WorkspaceScreen(
                    agents = Agents,
                    onOpenAgent = { screen = AppScreen.Thread },
                    demoActivity = true,
                )
                AppScreen.Thread -> ThreadScreen(
                    agent = Maya,
                    demoContent = true,
                    onBack = { screen = AppScreen.Workspace },
                    onOpenComputer = { screen = AppScreen.Computer },
                )
                AppScreen.Computer -> ComputerScreen(onBack = { screen = AppScreen.Thread })
            }
        }
    }
}

@Composable
internal fun WorkspaceScreen(
    agents: List<Agent>,
    sections: List<AgentSection> = emptyList(),
    onOpenAgent: (Agent) -> Unit,
    onOrganizeAgent: (Agent) -> Unit = {},
    onSignOut: (() -> Unit)? = null,
    demoActivity: Boolean = false,
) {
    var mode by rememberSaveable { mutableStateOf(WorkspaceMode.Agents) }
    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(Page)
            .statusBarsPadding(),
    ) {
        WorkspaceAppBar(onSignOut)
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
                WorkspaceMode.Agents -> AgentList(agents, sections, onOpenAgent, onOrganizeAgent)
                WorkspaceMode.Activity -> if (demoActivity) ActivityList() else EmptyState("Activity is not connected yet")
            }
        }
    }
}

@Composable
private fun WorkspaceAppBar(onSignOut: (() -> Unit)?) {
    var accountMenuOpen by remember { mutableStateOf(false) }
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
        Box {
            Surface(
                modifier = Modifier.size(48.dp)
                    .semantics { contentDescription = "Account" }
                    .clickable(enabled = onSignOut != null) { accountMenuOpen = true },
                shape = CircleShape,
                color = Elevated,
            ) {
                Box(contentAlignment = Alignment.Center) {
                    Icon(Icons.Outlined.Person, null, tint = TextSecondary)
                }
            }
            DropdownMenu(
                expanded = accountMenuOpen,
                onDismissRequest = { accountMenuOpen = false },
            ) {
                DropdownMenuItem(
                    text = { Text("Sign out") },
                    onClick = {
                        accountMenuOpen = false
                        onSignOut?.invoke()
                    },
                )
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
private fun AgentList(
    agents: List<Agent>,
    sections: List<AgentSection>,
    onOpenAgent: (Agent) -> Unit,
    onOrganizeAgent: (Agent) -> Unit,
) {
    var query by rememberSaveable { mutableStateOf("") }
    val visible = remember(query, agents) {
        agents.filter { agent ->
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
        val pinned = visible.filter { it.pinned }
        if (pinned.isNotEmpty()) {
            item { SectionLabel("Pinned") }
            items(pinned, key = { it.id }) { agent ->
                AgentRow(
                    agent = agent,
                    pinned = true,
                    onClick = { onOpenAgent(agent) },
                    onOptions = { onOrganizeAgent(agent) },
                )
            }
        }
        sections.forEach { section ->
            val sectionAgents = visible.filter { !it.pinned && it.sectionId == section.id }
            if (sectionAgents.isNotEmpty()) {
                item(key = "section-${section.id}") { SectionLabel(section.name) }
                items(sectionAgents, key = { it.id }) { agent ->
                    AgentRow(
                        agent = agent,
                        onClick = { onOpenAgent(agent) },
                        onOptions = { onOrganizeAgent(agent) },
                    )
                }
            }
        }
        val sectionIds = sections.mapTo(mutableSetOf()) { it.id }
        val unassigned = visible.filter { !it.pinned && (it.sectionId == null || it.sectionId !in sectionIds) }
        if (unassigned.isNotEmpty()) {
            if (pinned.isNotEmpty() || visible.any { !it.pinned && it.sectionId in sectionIds }) {
                item { SectionLabel("Unassigned") }
            }
            items(unassigned, key = { it.id }) { agent ->
                AgentRow(
                    agent = agent,
                    onClick = { onOpenAgent(agent) },
                    onOptions = { onOrganizeAgent(agent) },
                )
            }
        }
        if (visible.isEmpty()) item { EmptyState(if (query.isBlank()) "No agents yet" else "No matching agents") }
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

@OptIn(ExperimentalFoundationApi::class, ExperimentalMaterial3Api::class)
@Composable
private fun AgentRow(
    agent: Agent,
    pinned: Boolean = false,
    onClick: () -> Unit,
    onOptions: () -> Unit,
) {
    val haptics = LocalHapticFeedback.current
    val dismissState = rememberSwipeToDismissBoxState(
        positionalThreshold = { distance -> distance * 0.25f },
    )
    LaunchedEffect(dismissState.currentValue) {
        if (dismissState.currentValue != SwipeToDismissBoxValue.Settled) {
            haptics.performHapticFeedback(HapticFeedbackType.LongPress)
            onOptions()
            dismissState.snapTo(SwipeToDismissBoxValue.Settled)
        }
    }
    SwipeToDismissBox(
        state = dismissState,
        backgroundContent = {
            Box(
                modifier = Modifier.fillMaxSize().background(Elevated).padding(horizontal = 20.dp),
                contentAlignment = Alignment.CenterEnd,
            ) {
                Text("Options", color = TextSecondary, style = MaterialTheme.typography.labelLarge)
            }
        },
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .background(Page)
                .combinedClickable(
                    onClick = onClick,
                    onLongClickLabel = "Chat options",
                    onLongClick = {
                        haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                        onOptions()
                    },
                )
                .padding(horizontal = 20.dp, vertical = 14.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            OrganicAvatar(agent.id, agent.color, size = 54.dp, working = agent.status in ACTIVE_RUN_STATUSES)
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
    }
    HorizontalDivider(modifier = Modifier.padding(start = 90.dp), color = Border)
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun AgentOrganizeSheet(
    agent: Agent,
    sections: List<AgentSection>,
    onDismiss: () -> Unit,
    onSetPinned: suspend (Boolean) -> Unit,
    onMoveToSection: suspend (String?) -> Unit,
    onCreateSection: suspend (String) -> Unit,
    onSessionExpired: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    var creating by remember { mutableStateOf(false) }
    var name by remember { mutableStateOf("") }
    var saving by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    fun save(request: suspend () -> Unit) {
        if (saving) return
        saving = true
        error = null
        scope.launch {
            try {
                request()
                onDismiss()
            } catch (errorValue: IOException) {
                if (errorValue is ApiException && errorValue.status == 401) {
                    onDismiss()
                    onSessionExpired()
                } else {
                    error = errorValue.message ?: "Could not update chat"
                    saving = false
                }
            }
        }
    }

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        containerColor = Elevated,
        contentColor = TextPrimary,
    ) {
        Column(
            modifier = Modifier.fillMaxWidth().navigationBarsPadding().padding(horizontal = 16.dp),
        ) {
            Text(
                agent.name,
                modifier = Modifier.padding(horizontal = 10.dp, vertical = 8.dp),
                style = MaterialTheme.typography.titleLarge,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            OrganizeAction(
                icon = Icons.Outlined.PushPin,
                label = if (agent.pinned) "Unpin" else "Pin",
                enabled = !saving,
                onClick = { save { onSetPinned(!agent.pinned) } },
            )
            Text(
                "Move to",
                modifier = Modifier.padding(start = 10.dp, top = 12.dp, bottom = 4.dp),
                color = TextMuted,
                style = MaterialTheme.typography.labelLarge,
            )
            LazyColumn(modifier = Modifier.fillMaxWidth().heightIn(max = 240.dp)) {
                items(sections, key = { it.id }) { section ->
                    OrganizeAction(
                        icon = Icons.Outlined.Folder,
                        label = section.name,
                        selected = agent.sectionId == section.id,
                        enabled = !saving && agent.sectionId != section.id,
                        onClick = { save { onMoveToSection(section.id) } },
                    )
                }
                item {
                    OrganizeAction(
                        icon = Icons.Outlined.Folder,
                        label = "Unassigned",
                        selected = agent.sectionId == null,
                        enabled = !saving && agent.sectionId != null,
                        onClick = { save { onMoveToSection(null) } },
                    )
                }
            }
            if (creating) {
                Row(
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Surface(
                        modifier = Modifier.weight(1f),
                        shape = RoundedCornerShape(10.dp),
                        color = SurfaceColor,
                        border = androidx.compose.foundation.BorderStroke(1.dp, BorderStrong),
                    ) {
                        BasicTextField(
                            value = name,
                            onValueChange = { if (it.length <= 60) name = it },
                            modifier = Modifier.padding(horizontal = 12.dp, vertical = 12.dp),
                            singleLine = true,
                            textStyle = MaterialTheme.typography.bodyLarge.copy(color = TextPrimary),
                            decorationBox = { field ->
                                if (name.isBlank()) Text("Section name", color = TextMuted)
                                field()
                            },
                        )
                    }
                    Spacer(Modifier.width(8.dp))
                    TextButton(
                        enabled = !saving && name.isNotBlank(),
                        onClick = { save { onCreateSection(name.trim()) } },
                    ) { Text("Create", color = FocusBlue) }
                }
            } else {
                OrganizeAction(
                    icon = Icons.Outlined.CreateNewFolder,
                    label = "New section",
                    enabled = !saving,
                    onClick = { creating = true },
                )
            }
            if (error != null) {
                Text(
                    error.orEmpty(),
                    modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp),
                    color = Color(0xFFFF5364),
                    style = MaterialTheme.typography.bodySmall,
                )
            }
            TextButton(
                onClick = onDismiss,
                modifier = Modifier.align(Alignment.CenterHorizontally).heightIn(min = 48.dp),
            ) { Text("Cancel", color = TextSecondary) }
            Spacer(Modifier.height(8.dp))
        }
    }
}

@Composable
private fun OrganizeAction(
    icon: ImageVector,
    label: String,
    enabled: Boolean,
    selected: Boolean = false,
    onClick: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 48.dp)
            .clip(RoundedCornerShape(11.dp))
            .clickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(icon, null, modifier = Modifier.size(20.dp), tint = if (enabled) TextSecondary else TextMuted)
        Spacer(Modifier.width(12.dp))
        Text(
            label,
            modifier = Modifier.weight(1f),
            color = if (enabled) TextPrimary else TextMuted,
            style = MaterialTheme.typography.bodyLarge,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        if (selected) Icon(Icons.Outlined.Check, null, modifier = Modifier.size(18.dp), tint = TextSecondary)
    }
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
private fun EmptyState(message: String) {
    Box(Modifier.fillMaxSize().padding(32.dp), contentAlignment = Alignment.Center) {
        Text(message, color = TextMuted, style = MaterialTheme.typography.bodyLarge)
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
private fun LiveThreadScreen(
    agent: Agent,
    onBack: () -> Unit,
    loadThread: suspend (String) -> ThreadSnapshotRecord,
    sendMessage: suspend (String, String) -> Unit,
    onSessionExpired: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    val listState = rememberLazyListState()
    val scrollBehavior = remember(agent.id) { ThreadScrollBehavior() }
    var autoScrolling by remember(agent.id) { mutableStateOf(false) }
    var snapshot by remember(agent.id) { mutableStateOf<ThreadSnapshotRecord?>(null) }
    var loading by remember(agent.id) { mutableStateOf(true) }
    var error by remember(agent.id) { mutableStateOf<String?>(null) }
    var draft by rememberSaveable(agent.id) { mutableStateOf("") }
    var sending by remember(agent.id) { mutableStateOf(false) }
    var refreshGeneration by remember(agent.id) { mutableStateOf(0) }

    fun handle(errorValue: IOException) {
        if (errorValue is ApiException && errorValue.status == 401) {
            onSessionExpired()
            return
        }
        error = errorValue.message ?: "Could not reach the server"
    }

    LaunchedEffect(agent.id, refreshGeneration) {
        loading = snapshot == null
        error = null
        while (true) {
            val next = try {
                loadThread(agent.id)
            } catch (errorValue: IOException) {
                handle(errorValue)
                loading = false
                break
            }
            snapshot = next
            loading = false
            if (next.runStatus !in POLLING_RUN_STATUSES) break
            // ponytail: poll active runs; use threads/subscribe when live event rendering lands.
            delay(1_500)
        }
    }

    val working = snapshot?.runStatus in ACTIVE_RUN_STATUSES
    val atLatest by remember { derivedStateOf { !listState.canScrollForward } }

    LaunchedEffect(listState) {
        snapshotFlow { listState.isScrollInProgress to listState.canScrollForward }.collect { (scrolling, canScrollForward) ->
            if (scrolling && !autoScrolling) scrollBehavior.onUserScroll(canScrollForward)
        }
    }

    LaunchedEffect(snapshot?.threadId, snapshot?.messages?.lastOrNull()?.id, working) {
        val threadId = snapshot?.threadId ?: return@LaunchedEffect
        if (!scrollBehavior.shouldScrollToLatest(threadId)) return@LaunchedEffect
        autoScrolling = true
        try {
            withFrameNanos { }
            val lastIndex = listState.layoutInfo.totalItemsCount - 1
            if (lastIndex >= 0) listState.scrollToItem(lastIndex)
        } finally {
            autoScrolling = false
        }
    }

    Column(modifier = Modifier.fillMaxSize().background(Page).statusBarsPadding()) {
        AgentTopBar(
            agent = agent,
            demoContent = working,
            showActions = false,
            onBack = onBack,
            onOpenComputer = null,
        )
        HorizontalDivider(color = Border)
        when {
            loading && snapshot == null -> Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
                CircularProgressIndicator(color = FocusBlue, strokeWidth = 2.dp)
            }
            snapshot == null -> ThreadLoadFailure(
                message = error ?: "Could not load messages",
                onRetry = { refreshGeneration += 1 },
                modifier = Modifier.weight(1f),
            )
            else -> {
                Box(modifier = Modifier.weight(1f).fillMaxWidth()) {
                    LazyColumn(
                        state = listState,
                        modifier = Modifier.fillMaxSize(),
                        contentPadding = PaddingValues(horizontal = 20.dp, vertical = 20.dp),
                        verticalArrangement = Arrangement.spacedBy(20.dp),
                    ) {
                        error?.let { message -> item { ThreadError(message) } }
                        snapshot?.runError?.let { message -> item { ThreadError(message) } }
                        val messages = snapshot?.messages.orEmpty()
                        if (messages.isEmpty()) {
                            item { EmptyThread() }
                        } else {
                            items(messages, key = { it.id }) { message -> ThreadMessage(message) }
                        }
                        if (working) item(key = "working-${agent.id}") { WorkingAgentMarker(agent) }
                    }
                    androidx.compose.animation.AnimatedVisibility(
                        visible = !atLatest,
                        modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = 12.dp),
                        enter = fadeIn(tween(180)) + slideInVertically(tween(180)) { it / 3 },
                        exit = fadeOut(tween(140)) + slideOutVertically(tween(140)) { it / 3 },
                    ) {
                        Surface(
                            modifier = Modifier
                                .size(48.dp)
                                .semantics { contentDescription = "Jump to latest" }
                                .clickable {
                                    scrollBehavior.jumpToLatest()
                                    scope.launch {
                                        autoScrolling = true
                                        try {
                                            val lastIndex = listState.layoutInfo.totalItemsCount - 1
                                            if (lastIndex >= 0) listState.animateScrollToItem(lastIndex)
                                        } finally {
                                            autoScrolling = false
                                        }
                                    }
                                },
                            shape = CircleShape,
                            color = Elevated,
                            border = androidx.compose.foundation.BorderStroke(1.dp, BorderStrong),
                            shadowElevation = 8.dp,
                        ) {
                            Box(contentAlignment = Alignment.Center) {
                                Icon(Icons.Outlined.ArrowDownward, null, tint = TextSecondary, modifier = Modifier.size(20.dp))
                            }
                        }
                    }
                }
                HorizontalDivider(color = Border)
                Composer(
                    value = draft,
                    onValueChange = { draft = it },
                    onSend = {
                        val message = draft.trim()
                        if (message.isEmpty() || sending) return@Composer
                        sending = true
                        error = null
                        scope.launch {
                            try {
                                sendMessage(agent.id, message)
                                draft = ""
                                refreshGeneration += 1
                            } catch (errorValue: IOException) {
                                handle(errorValue)
                            } finally {
                                sending = false
                            }
                        }
                    },
                    placeholder = "Message ${agent.name}",
                    enabled = !sending,
                    showSecondaryActions = false,
                )
            }
        }
    }
}

@Composable
private fun WorkingAgentMarker(agent: Agent) {
    Row(
        modifier = Modifier.fillMaxWidth().heightIn(min = 40.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        OrganicAvatar(agent.id, agent.color, size = 28.dp, working = true)
        Spacer(Modifier.width(10.dp))
        Text("${agent.name} is working", color = TextMuted, style = MaterialTheme.typography.bodyMedium)
    }
}

@Composable
private fun ThreadLoadFailure(message: String, onRetry: () -> Unit, modifier: Modifier = Modifier) {
    Box(modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Text(message, color = TextMuted, style = MaterialTheme.typography.bodyLarge)
            TextButton(onClick = onRetry) { Text("Retry", color = FocusBlue) }
        }
    }
}

@Composable
private fun EmptyThread() {
    Box(Modifier.fillMaxWidth().height(220.dp), contentAlignment = Alignment.Center) {
        Text("No messages yet", color = TextMuted, style = MaterialTheme.typography.bodyLarge)
    }
}

@Composable
private fun ThreadError(message: String) {
    Surface(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(14.dp),
        color = SurfaceColor,
        border = androidx.compose.foundation.BorderStroke(1.dp, BorderStrong),
    ) {
        Text(message, modifier = Modifier.padding(16.dp), color = Color(0xFFFF8A8A))
    }
}

@Composable
private fun ThreadMessage(message: ThreadMessageRecord) {
    val text = message.blocks.map(MessageBlockRecord::text).filter(String::isNotBlank).joinToString("\n")
    if (message.role == "user") {
        if (text.isNotBlank()) UserBubble(text)
        return
    }
    if (message.role == "system") {
        if (text.isNotBlank()) ThreadEvent(text)
        return
    }
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        message.blocks.forEach { block ->
            if (block.label == null) {
                if (block.text.isNotBlank()) {
                    Text(block.text, color = TextPrimary, style = MaterialTheme.typography.bodyLarge)
                }
            } else {
                SemanticCard(title = block.label) {
                    if (block.text.isNotBlank()) {
                        Text(block.text, color = TextPrimary, style = MaterialTheme.typography.bodyLarge)
                    }
                    block.detail?.let { detail ->
                        Text(detail, color = TextMuted, style = MaterialTheme.typography.bodyMedium)
                    }
                }
            }
        }
    }
}

@Composable
private fun ThreadScreen(
    agent: Agent,
    demoContent: Boolean,
    onBack: () -> Unit,
    onOpenComputer: (() -> Unit)?,
) {
    val sentMessages = remember { mutableStateListOf<String>() }
    var draft by rememberSaveable { mutableStateOf("") }
    Column(
        modifier = Modifier.fillMaxSize().background(Page).statusBarsPadding(),
    ) {
        AgentTopBar(agent = agent, demoContent = demoContent, onBack = onBack, onOpenComputer = onOpenComputer)
        HorizontalDivider(color = Border)
        if (demoContent) {
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
        } else {
            Box(Modifier.fillMaxSize().weight(1f), contentAlignment = Alignment.Center) {
                Text("Messages aren’t connected yet", color = TextMuted, style = MaterialTheme.typography.bodyLarge)
            }
        }
    }
}

@Composable
private fun AgentTopBar(
    agent: Agent,
    demoContent: Boolean,
    showActions: Boolean = demoContent,
    onBack: () -> Unit,
    onOpenComputer: (() -> Unit)?,
) {
    Row(
        modifier = Modifier.fillMaxWidth().height(76.dp).padding(horizontal = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        IconButton(onClick = onBack) {
            Icon(Icons.AutoMirrored.Outlined.ArrowBack, "Back", tint = TextSecondary)
        }
        OrganicAvatar(agent.id, agent.color, size = 44.dp, working = demoContent)
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text(agent.name, style = MaterialTheme.typography.titleLarge)
            Text(
                if (demoContent) "Working" else agent.summary,
                color = TextMuted,
                style = MaterialTheme.typography.bodyMedium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        if (showActions) {
            IconButton(onClick = {}) { Icon(Icons.Outlined.Call, "Start voice call", tint = TextSecondary) }
        }
        if (onOpenComputer != null) {
            IconButton(onClick = onOpenComputer) {
                Icon(Icons.Outlined.DesktopWindows, "Open ${agent.name}’s computer", tint = TextSecondary)
            }
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
private fun Composer(
    value: String,
    onValueChange: (String) -> Unit,
    onSend: () -> Unit,
    placeholder: String = "Message Maya",
    enabled: Boolean = true,
    showSecondaryActions: Boolean = true,
) {
    Row(
        modifier = Modifier.fillMaxWidth().navigationBarsPadding().padding(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (showSecondaryActions) {
            CircleIconButton(Icons.Outlined.Add, "Attach") {}
            Spacer(Modifier.width(8.dp))
        }
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
                    enabled = enabled,
                    modifier = Modifier.weight(1f),
                    singleLine = true,
                    textStyle = MaterialTheme.typography.bodyLarge.copy(color = TextPrimary),
                    decorationBox = { field ->
                        if (value.isEmpty()) Text(placeholder, color = TextMuted)
                        field()
                    },
                )
                if (showSecondaryActions) {
                    IconButton(onClick = {}) { Icon(Icons.Outlined.MicNone, "Voice message", tint = TextMuted) }
                }
            }
        }
        Spacer(Modifier.width(8.dp))
        Surface(
            modifier = Modifier.size(54.dp).clickable(enabled = enabled && value.isNotBlank(), onClick = onSend),
            shape = CircleShape,
            color = Cream.copy(alpha = if (enabled && value.isNotBlank()) 1f else 0.5f),
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
    RakazoTheme { DemoRakazoApp() }
}
