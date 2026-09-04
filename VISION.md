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
Consequential actions respect explicit approval policy, and uncertain automated review fails toward asking rather than silently acting.
Authentication, secret handling, sandbox boundaries, host commands, and integrations are treated as security-sensitive product behavior.
Important effects are verified independently, recovery preserves known-good user state, and core tests remain deterministic and offline by default.

## Current decisions

This file records current product truth rather than an append-only decision log, and Git history preserves decisions that are later replaced.
One bot has one continuous visible thread because continuity is part of its identity, while internal runs and attempts remain implementation detail.
Team Computers share a persisted browser identity and isolate simultaneous live desktops when supported because shared login state and safe concurrency are both required.
Private Computers isolate the entire working home because some trust boundaries must be stronger than collaboration convenience.
Connections belong to the user or space rather than requiring repetitive per-bot setup because bots differ through role and state, not account plumbing.

## Scope

Rakazo is not a model provider, a hosted-only service, a general virtual-machine manager, a visual workflow builder, or a CI system.
Rakazo does not promise that a trusted host computer or third-party destination is isolated from data deliberately sent to it.
Implementation plans and technical documentation explain mechanics, but this file is authoritative when product direction conflicts with an older plan.
A change aligns when it strengthens persistent useful work, user ownership, safe autonomy, shared product behavior, or calm interaction without weakening an explicit boundary.
A change should be resisted when it creates mandatory lock-in, fragments the product by surface, exposes internal machinery as user burden, weakens ownership or isolation, or adds capability without a durable place in a bot's work.
