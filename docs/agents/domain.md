# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

Single-context repo — one glossary at the root, design docs under `docs/`. There is no `CONTEXT.md` / `CONTEXT-MAP.md` / `docs/adr/` here; the equivalents are listed below.

## Before exploring, read these

- **`CONCEPTS.md`** at the repo root — the glossary. Shared domain vocabulary: proxy boundary, execution strategies, routing terms. This is the `CONTEXT.md` equivalent for this repo.
- **`docs/design/README.md`** — index of the current architecture and design
  documents. Follow it to the documents that touch the area you're about to
  change; do not rely on a hard-coded three-file subset.
- **`docs/solutions/`** — documented solutions to past problems, organized by category (`conventions/`, `integration-issues/`, `testing/`) with YAML frontmatter (`module`, `tags`, `problem_type`). Check for an entry matching the module you're touching before diagnosing something that may already be solved.

If these do not cover the area you need, proceed with the code. Use
`domain-modeling` when a domain term is actually resolved, and append it to
`CONCEPTS.md` rather than creating a new context file. Use `codebase-design`
when the task is to sharpen a module interface; architectural changes update
the relevant document indexed by `docs/design/README.md`.

## File structure

```
/
├── CONCEPTS.md              ← glossary (CONTEXT.md equivalent)
├── AGENTS.md                ← agent instructions (CLAUDE.md is a symlink to it)
├── docs/
│   ├── design/              ← indexed architecture and design decisions
│   │   └── README.md        ← current design-doc index
│   └── solutions/           ← documented past problems, by category
│       ├── conventions/
│       ├── integration-issues/
│       └── testing/
└── src/
```

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `CONCEPTS.md`. Don't drift to synonyms the glossary explicitly avoids — "Native Messages", "Responses Translation", and "Chat Completions Fallback" are the strategy names; "proxy boundary" and "translation policy" are the boundary terms.

If the concept you need is not in the glossary, either reuse existing project
language or record the resolved gap through `domain-modeling`.

## Flag design-doc conflicts

If your output contradicts a decision recorded in `docs/design/`, surface it explicitly rather than silently overriding:

> _Contradicts `docs/design/model-routing.md` (fallback ordering) — but worth reopening because…_

Architectural changes update the relevant design doc in the same change (see `AGENTS.md`).
