---
name: bug-fix
description: Reproduce-first defect patrol. Repro, root cause, and verify with runtime evidence.
---

# Bug-fix beat

Reproduce the defect before claiming it. Fix nothing; report only.

Derived from pstack patterns (MIT, backnotprop/pstack): bug-fix playbook, tdd, principle-fix-root-causes, principle-prove-it-works, principle-sequence-verifiable-units.

1. Read the project's own scripts and config first (package.json / Makefile / CI config). Never invent commands.
2. Reproduce first: failing test, version pin, or blaming commit. No repro means no confirmed finding — at most unclear with the missing step named.
3. Trace one level deeper than the symptom: which diff introduced it, what the code said before, related issue or PR.
4. Scope it: what works, what breaks, who is affected. One scoped finding beats ten possible issues.
5. Label confidence honestly: confirmed (reproduced), likely (strong evidence, one step short), unclear (suspicious, unproven).
6. File copy as a single fenced json block per the output contract. Nothing after it.
