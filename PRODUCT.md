# Product definition

[VISION.md](VISION.md) defines Rakazo's purpose, principles, and boundaries.
This document defines behavior by capability so feature work has one shared product reference across web, desktop, mobile, and messaging wherever applicable.
It is a maintained definition, not an exhaustive feature inventory, roadmap, implementation plan, or release checklist.
Update the relevant section when a product decision changes; Git history preserves replaced decisions.

## Status and use

The recorded decisions below carry forward the existing product requirements from VISION.md without a new implementation audit.
They define expected behavior, not proof that every path already conforms.
The subagent section separately records the intended change agreed during review of [PR #3101](https://github.com/elie222/rakazo/pull/3101); it is not a claim that the change has shipped.
Keep implementation gaps explicit when adding a capability, and keep technical plans and verification evidence in the relevant PR or technical documentation.

## Conversation

One bot has one continuous visible thread because continuity is part of its identity, while internal runs and attempts remain implementation detail.
A pending question or approval card never blocks a chat: the user can always keep chatting and new work still runs, and the card stays answerable until someone replies.

## Activity

The chat list has a regular view and an Activity view and shows one at a time on every surface, because listing the same chats in both only repeats them.
Activity replaces the whole regular list, including pinned chats and the archived and snoozed shelves, which return when the user leaves Activity.

## Subagents

Status: intended behavior; implementation remains to be aligned.

A subagent is delegated work for the parent bot, not a separately configured bot or a second user-facing conversation.
Subagents run independently while the parent remains available to respond to new messages and handle new requests.
The parent may wait for results before giving a final answer, but that dependency does not block conversation.
There is one subagent behavior, without a foreground/background choice for the user or bot.
Subagents can take actions using the tools and permissions applicable to their task; asynchronous execution does not make them read-only.
Delegation does not grant additional authority or bypass approval rules.
A required approval remains reachable from the user's conversation without blocking unrelated work.
Shared resources such as a computer screen coordinate access so simultaneous actions do not interfere; only work using that resource waits.
Results return to the parent, which combines relevant results and continues the task or answers the user.
The parent accounts for changed instructions and cancellation before acting on a late result.

For example, a bot comparing three options can delegate their research, answer a new question while that research continues, and give its recommendation once the needed results arrive.

Implementation gap: the existing in-turn subagent call waits for its result before the parent continues.
PR #3101 proposes optional background execution with read-only helpers; that proposal does not yet provide the single behavior and action capabilities defined here.

## Computers

A Team Computer shares files, installed tools, and a canonical browser identity among bots inside the same trust boundary.
Rakazo gives each concurrently active Team bot a separate live desktop and browser process when the provider supports it, and unsupported providers expose the limitation instead of silently coupling control.
Browser sign-ins are checkpointed into the shared identity and become available to desktops opened or restarted after that checkpoint.
Concurrent Chromium processes do not write directly to one profile directory, and generation fencing prevents older desktops from overwriting newer shared state.
A Private Computer isolates the entire working home, including files and browser identity, when working state must not be shared with other bots.
Computer resources start lazily and are released when inactive so configured capacity does not become permanently reserved memory.
User takeover grants exclusive control of one bot's screen without unnecessarily blocking other bots on their own screens.

## Connections, skills, and plugins

Connections belong to the user or space rather than requiring repetitive per-bot setup because bots differ through role and state, not account plumbing.
Plugins in the shared plugin format install as ordinary connectors and skills rather than a runtime of their own, so sign-in, approvals and per-bot enablement work the same wherever a capability came from.
The built-in plugin catalog lists only plugins whose every part installs, because a half-working default is worse than none, while a plugin imported by URL installs what works and names what it left out.
Plugin parts that would run the plugin's own code on our side, such as hooks, language servers, local MCP commands and skill scripts, are not installed, because executing third-party code is a boundary the catalog does not cross.
Integrations is where apps are connected and skills have their own place, because a skill is know-how that needs no account and many skills have nothing to connect.
A brand's connector and its skills are added separately, because connecting an app should not also load dozens of playbooks.

## Account defaults and space availability

Settings such as models, voice and approvals are account defaults that every space follows, and a space customizes one only as a deliberate exception, because few people want a different setup per space and spaces exist to separate work, not configuration.
Skills, MCP servers, plugins and tool sources belong to the account of the user who added them, and each is available in all of that user's spaces or only in chosen ones, because one setup should serve every space while spaces stay private.
All spaces includes spaces created later, because choosing it means the item should follow the user wherever they work.
What a user adds is available in all their spaces until they narrow it, and what a bot creates, such as a skill, is available only in the space it was created in, because a bot's writing may carry that space's private details.
A bot changes only skills that live in its space alone, because editing one that other spaces read would carry this space's details into them.
Items that existed before availability did stay available only in the space they were in, so nothing became visible somewhere new.
Bots use what is available in their space, and each bot still chooses which apps it uses, because availability decides what a space may touch and the bot decides what it needs.
A teammate in a shared space never gets another member's items, because availability spans one owner's spaces, never other people.
Models, voice and approval settings follow the same account-first rule without a per-item choice, because they carry no private content and the per-space override covers the exceptions.
Managed app connections stay with the space they were connected in for now, because a hosted connector provider can identify connected accounts per space and moving them would disconnect them.
Choosing where something is available appears only to someone with more than one space, because with one space there is nothing to choose.

Provider setup shows the provider, one short description of its role, and only the fields required to connect with the default configuration. Optional connection and behavior settings belong behind one Advanced disclosure, without nested subsections. Keep required fields visible when no default exists.

## Memory

Bots can build general knowledge about a user together while keeping bot-specific memories. Cross-bot learning and intentionally shared memory are supported within a Space; memory never crosses Space boundaries implicitly. Learning may retain outside-derived knowledge, but remembering, summarizing or relaying it never makes it an owner instruction. Provenance follows conversation history and deliveries; recalled knowledge is always derived data, even when it came from the bot's own bank. Provenance does not disable learning or grant action permissions. Stored history and automatic recall preserve this provenance without changing current owner permissions; explicit tool reads still follow the existing authorization and approval rules.

## Approvals

Approvals have three modes: Never ask runs every action without waiting, Auto lets an approval model pass actions that fit what the owner asked for and asks only when one is off-task or irreversible without being asked for, and Ask asks before any action that changes something; reading asks only when the request itself could carry private data somewhere new.
Every mode is shaped by two lists of exact tools or sites, Allow and Block, which grow from approval cards and settings rather than from guessed categories, and a blocked action is refused without a card in every mode.
Actions that outside text could steer, such as writes in webhook-started runs, another owner's bot connecting, or instruction changes after untrusted content entered a run, still ask in Auto and Ask. Never ask runs them, except that it refuses another owner's bot connecting when outside text could have asked for it.
The deployment picks the default approval mode, so a self-hosted server works without any model and a hosted one can default to Auto.

## Deployment administration and host access

App accounts never administer the server.
Signup order, email address, and workspace ownership do not grant deployment privileges or billing exemptions.
The only admins are verified accounts the operator lists in `RAKAZO_ADMIN_EMAILS`; nothing in the app can add one, and they can only review plugin submissions, add stdio MCP servers, and give capped credits or free own-key months, never change the server or read other accounts.
Operators configure the server through environment variables and manage updates, logs, and shared credentials through deployment tooling.
Desktop host access is a separate local capability that requires native confirmation, is restricted to the app-managed local instance, and can be revoked locally.
