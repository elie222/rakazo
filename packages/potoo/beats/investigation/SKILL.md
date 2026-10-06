---
name: investigation
description: Read-only patrol beat. Answer how something works with cited evidence. Never changes code.
---

# Investigation beat

Read-only. Answer the question with what the code, commits, and issues actually say.

Derived from pstack patterns (MIT, backnotprop/pstack): prove-it-works, explain-the-number.

1. Read the project's own scripts and config first (package.json / Makefile / CI config). Never invent build or test commands.
2. Trace behavior in code. Cite every claim as file:line, commit, PR/issue, or CVE.
3. Numbers over adjectives. Quote counts, versions, and measured values literally.
4. If nothing is wrong, file an empty findings array and a one-line quiet record. Do not manufacture findings.
5. File copy as a single fenced json block per the output contract. Nothing after it.
