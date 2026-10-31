# Feature priorities

Prioritize safe delegation first, then visibility, then wider autonomy.

| Rank | Improvement | Reason |
| --- | --- | --- |
| 1 | Secure credential forms (#5) | Connecting an account must not put passwords or API keys in chat or model input. |
| 2 | Detailed approval rules (#6) | Owners need explicit boundaries before delegating consequential actions. |
| 3 | Advanced Auto Review (#1) | Within those boundaries, assess each action and ask when automatic review is insufficient. |
| 4 | Notification management (#3) | Agent names and avatars identify the sender; attention states surface actionable interruptions. Current priority. |
| 5 | Live execution transparency (#7) | Owners need to see what happened and intervene in the conversation. |
| 6 | Advanced provider usage tracking (#12) | Usage windows and reset times help owners plan work before limits interrupt it. |
| 7 | Multi-agent handoffs (#10) | Delegation needs clear ownership and preserved progress. |
| 8 | Group chat collaboration (#4) | Replies, mentions and reactions build on clear ownership. |
| 9 | Chief of Staff capabilities (#9) | Reliable priorities and deadlines require trustworthy agent state. |
| 10 | Proactive agents (#2) | Unprompted work needs permission boundaries and a manageable attention system. |
| 11 | Workflow learning (#8) | Learning is useful once workflows are visible, reliable and correctable. |
| 12 | X (Twitter) agent integration (#11) | Public task entry needs verified accounts and permission boundaries before agents can act. |

## First delivery

Secure credential forms already support passwords, API keys and website logins on web,
Electron and mobile. Submitted values stay outside conversation text and model input;
reusable credentials are encrypted. See [Reusable credentials](bot-secrets.md) for supported
destinations and the limits of shell variables and browser login protection.

Individual permissions use exact tool names, with Allow, Ask and Block choices. Settings can
now create a tool rule before an action happens and switch existing tool, connector and site
rules back to Ask. These changes apply to account settings or a Space's separate settings,
using the same backend on every surface. Existing block precedence, explicit human approval
requirements and Never ask mode behavior remain unchanged. A tool rule covers that tool;
it does not interpret arbitrary shell code as separate email, deletion or purchase actions.

Auto Review already assesses individual actions using the configured checker and falls back
to approval when it cannot review them. Approval cards provide Allow once, Always allow
where supported, and Deny. LLM and structured decision checkers now also ask without making
a model call when the action arguments, owner task or bot description would be truncated.
A new site's URL is still reviewed in full. This protects against approving a partial action;
it does not change the semantic risk rubric or claim new model calibration.

## Notification management

Activity separates Needs attention, Working and Unread, while retaining recent run history.
Sender identity travels with push notifications as a small image; it never contains credentials
or requires publishing a private avatar URL. Web and desktop use the bot's saved image or a static
version of its avatar. Mobile native builds add sender portraits to push notifications; existing
builds keep their current presentation until updated. The operating system still controls app attribution.


Native sender portraits require a new mobile binary. Android registers its support before the
server uses data-only delivery; older registrations continue standard pushes. iOS uses a
communication notification extension and requires its entitlement and provisioning profile.
The operating system can keep Rakazo's app name and small attribution icon alongside the sender.
Browser notifications need permission and an open app tab; unsupported system icon presentation
still retains the agent's name. Needs-attention pushes use the existing attention channel;
working updates stay silent and foreground completions stay suppressed.

## Added follow-up proposals

**Advanced provider usage tracking (#12):** show five-hour and weekly usage percentages,
reset times and available limit-reset credits for Codex, Claude Code and supported providers,
with redemption where a provider exposes an authorized API. Keep this behind shared usage
contracts and provider adapters; unavailable windows or redemption must remain explicitly
unsupported rather than being estimated from token counts. This is ranked sixth and is not
implemented in this delivery.

**X (Twitter) agent integration (#11):** an optional plugin/MCP can let authorized users tag
agents in replies to execute tasks. Bind the X account to an authenticated Rakazo account,
verify inbound events, require explicit agent/task permissions, and deduplicate deliveries.
Public replies are untrusted input and never permission grants. This is ranked twelfth and
is not implemented in this delivery.
