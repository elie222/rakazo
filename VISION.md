# Vision

Rakazo exists so that people can own AI teammates that persist, use computers, and finish work beyond a single chat.
It serves people who want capable agents without surrendering their choice of models, infrastructure, or where their data lives.
It owns exactly one thing: the durable home in which each AI teammate's identity, conversation, memory, routines, and computer remain available over time.

## Persistent teammates, not disposable chats

A bot is a continuing identity with one visible conversation and durable working state.
A bot works in the background, returns with a result, and asks for help only when it needs information, judgment, authorization, or protected input.
A bot remains available for conversation while its work continues.
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
Shared working state respects explicit trust boundaries, and simultaneous work does not silently couple control.
Private working state remains available when collaboration would cross those boundaries.
User takeover grants exclusive control of the relevant screen without unnecessarily blocking unrelated work.

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

## Scope

Rakazo is not a model provider, a hosted-only service, a general virtual-machine manager, a visual workflow builder, or a CI system.
Rakazo does not promise that a trusted host computer or third-party destination is isolated from data deliberately sent to it.
[PRODUCT.md](PRODUCT.md) defines behavior by capability and identifies intended changes that are not yet implemented.
Implementation plans and technical documentation explain mechanics; they follow this vision and the product definition.
A change aligns when it strengthens persistent useful work, user ownership, safe autonomy, shared product behavior, or calm interaction without weakening an explicit boundary.
A change should be resisted when it creates mandatory lock-in, fragments the product by surface, exposes internal machinery as user burden, weakens ownership or isolation, or adds capability without a durable place in a bot's work.
