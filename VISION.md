# Vision

Rakazo exists so that people can own AI teammates that persist, use computers, and finish work beyond a single chat.
It serves people who want capable agents without surrendering their choice of models, infrastructure, or where their data lives.
It owns exactly one thing: the durable home in which each AI teammate's identity, conversation, memory, routines, and computer remain available over time.

## Persistent teammates, not disposable chats

A bot is a continuing identity with one visible conversation and durable working state.
A bot works in the background, returns with a result, and asks for help only when it needs information, judgment, authorization, or protected input.
Useful work lands in the destination where it belongs instead of ending as an unsupported claim in chat.
Changes that reduce bots to prompt presets or isolated one-off tasks work against the product.

## Ownership includes choice

The complete core product runs on infrastructure controlled by its operator under an open-source license.
No hosted vendor is required for models, computers, memory, voice, integrations, or another core workflow.
External services remain optional choices behind provider-neutral contracts, and new providers reuse shared contracts and deterministic offline conformance tests.
Bot state remains inspectable, exportable, recoverable, and portable across provider failure or replacement.
A managed Rakazo service may improve convenience, but it does not become a hidden dependency of the self-hosted core.

## One product across every surface

Web, Electron, mobile, and messaging surfaces expose the same bots and durable state through shared product contracts.
Core workflows work on every applicable surface or degrade safely for an explicit reason.
Shared behavior, orchestration, and reusable interface logic live in shared packages.
Platform-specific code is reserved for native navigation, storage, permissions, and interactions that genuinely differ.

## Computers are durable places

A computer is persistent working state even when its underlying process, container, or virtual machine is suspended or replaced.
A Team Computer shares files, installed tools, and a canonical browser identity among bots inside the same trust boundary.
Rakazo gives each concurrently active Team bot a separate live desktop and browser process when the provider supports it, and unsupported providers expose the limitation instead of silently coupling control.
Browser sign-ins are checkpointed into the shared identity and become available to desktops opened or restarted after that checkpoint.
Concurrent Chromium processes do not write directly to one profile directory, and generation fencing prevents older desktops from overwriting newer shared state.
A Private Computer remains the explicit choice when files, browser identity, or working state must not be shared with other bots.
Computer resources start lazily and are released when inactive so configured capacity does not become permanently reserved memory.
User takeover grants exclusive control of one bot's screen without unnecessarily blocking other bots on their own screens.

## Calm on the surface, rigorous underneath

Chat shows the bot's response, useful progress, results, and genuine requests for help rather than its internal tool lifecycle.
The interface removes explanatory copy and persistent chrome unless they change a decision, and advanced capability appears progressively when relevant.
Frontends express intent and render state while the backend owns orchestration, authorization, validation, retries, recovery, and provider translation.
Routines remain scheduled prompts rather than becoming a visual workflow language.
Implementation complexity is acceptable only when it protects a real boundary or makes the user experience simpler and more reliable.

## Trust is explicit and verified

Spaces are authorization boundaries across which private chats, files, memory, computers, and integrations do not mix implicitly.
Sharing a bot transfers an intentional configuration, not its computer, credentials, files, private memory, or history.
Consequential actions follow the owner's approval mode and lists, and an automated review that errors or is unsure asks rather than silently acting.
Authentication, secret handling, sandbox boundaries, host commands, and integrations are treated as security-sensitive product behavior.
Important effects are verified independently, recovery preserves known-good user state, and core tests remain deterministic and offline by default.

## Current decisions

App accounts never administer the server. Signup order, email address, and workspace ownership do not grant deployment privileges or billing exemptions; there is no app-admin role or `ADMINS` list. Operators configure the server through environment variables and manage updates, logs, and shared credentials through deployment tooling. Desktop host access is a separate local capability that requires native confirmation, is restricted to the app-managed local instance, and can be revoked locally.

This file records current product truth rather than an append-only decision log, and Git history preserves decisions that are later replaced.
A pending question or approval card never blocks a chat: the user can always keep chatting and new work still runs, and the card stays answerable until someone replies.
One bot has one continuous visible thread because continuity is part of its identity, while internal runs and attempts remain implementation detail.
Team Computers share a persisted browser identity and isolate simultaneous live desktops when supported because shared login state and safe concurrency are both required.
Private Computers isolate the entire working home because some trust boundaries must be stronger than collaboration convenience.
Connections belong to the user or space rather than requiring repetitive per-bot setup because bots differ through role and state, not account plumbing.
Plugins in the shared plugin format install as ordinary connectors and skills rather than a runtime of their own, so sign-in, approvals and per-bot enablement work the same wherever a capability came from.
The built-in plugin catalog lists only plugins whose every part installs, because a half-working default is worse than none, while a plugin imported by URL installs what works and names what it left out.
Plugin parts that would run the plugin's own code on our side, such as hooks, language servers, local MCP commands and skill scripts, are not installed, because executing third-party code is a boundary the catalog does not cross.
Integrations is where apps are connected and skills have their own place, because a skill is know-how that needs no account and many skills have nothing to connect.
A brand's connector and its skills are added separately, because connecting an app should not also load dozens of playbooks.
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
Approvals have three modes: Never ask runs every action without waiting, Auto lets an approval model pass actions that fit what the owner asked for and asks only when one is off-task or irreversible without being asked for, and Ask asks before any action that changes something; reading asks only when the request itself could carry private data somewhere new.
Every mode is shaped by two lists of exact tools or sites, Allow and Block, which grow from approval cards and settings rather than from guessed categories, and a blocked action is refused without a card in every mode.
Actions that outside text could steer, such as writes in webhook-started runs, another owner's bot connecting, or instruction changes after untrusted content entered a run, still ask in Auto and Ask. Never ask runs them, except that it refuses another owner's bot connecting when outside text could have asked for it.
The deployment picks the default approval mode, so a self-hosted server works without any model and a hosted one can default to Auto.

## Scope

Rakazo is not a model provider, a hosted-only service, a general virtual-machine manager, a visual workflow builder, or a CI system.
Rakazo does not promise that a trusted host computer or third-party destination is isolated from data deliberately sent to it.
Implementation plans and technical documentation explain mechanics, but this file is authoritative when product direction conflicts with an older plan.
A change aligns when it strengthens persistent useful work, user ownership, safe autonomy, shared product behavior, or calm interaction without weakening an explicit boundary.
A change should be resisted when it creates mandatory lock-in, fragments the product by surface, exposes internal machinery as user burden, weakens ownership or isolation, or adds capability without a durable place in a bot's work.
