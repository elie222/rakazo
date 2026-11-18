---
name: prune-tests
description: Audit and prune tests that duplicate coverage or guard no current behavior.
---

For each candidate, identify the regression it could catch. Remove the test if it guards no current requirement or if a named surviving test would fail on the same regression. Where a brittle test is the only coverage for a real behavior, keep that coverage and assert the observable result at the appropriate boundary.

1. **Scope the audit.** Use the requested files or feature. Check nearby suites that might cover the same behavior. Treat repeated names and assertions as search leads. Read the production entry point and the surviving test before deciding.
2. **Compare guarantees.** Match the input, failure mode, and boundary. Clients can share cases for a common helper, while each still needs coverage for its own wiring. A mock assertion can protect a real side effect such as sending once or leaving storage untouched after refusal. Preserve coverage of security boundaries, migrations, old clients, and repository conventions. A negative test for an old path can still matter if its return would break one of those guarantees.
3. **Make a focused patch.** Prefer removing redundant cases, stale assertions, or tests of the runtime itself. Remove a helper used only by deleted tests after checking references in the whole repo. Keep unrelated production refactors out. A run with no justified removals is complete.
4. **Verify the surviving coverage.** Run the relevant suites, including the tests cited as replacements. Use the repository's CI paths for browser and device coverage. If reporting a Vitest case count, collect the affected files before and after with `vitest list --no-staticParse` so parameterized rows are counted. Report net cases and lines separately and name any verification gaps.

Report the scope, what can be removed, the surviving coverage, and what you verified.
