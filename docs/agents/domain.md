# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

Single-context repo — one glossary at the root, design docs under `docs/`. There is no `CONTEXT.md` / `CONTEXT-MAP.md` / `docs/adr/` here; the equivalents are listed below.

## Before exploring, read these

- **`CONCEPTS.md`** at the repo root — the glossary. Shared domain vocabulary: proxy boundary, execution strategies, routing terms. This is the `CONTEXT.md` equivalent for this repo.
- **`docs/design/`** — the architectural-decision surface (`execution-strategy.md`, `model-routing.md`, `translation-pipeline.md`). Read the ones that touch the area you're about to work in. These are the ADR equivalent here: they record the decision, not just the description.
- **`docs/solutions/`** — documented solutions to past problems, organized by category (`conventions/`, `integration-issues/`, `testing/`) with YAML frontmatter (`module`, `tags`, `problem_type`). Check for an entry matching the module you're touching before diagnosing something that may already be solved.

If any of these don't cover the area you need, **proceed silently**. Don't flag the gap or suggest creating docs upfront. `/domain-modeling` (reached via `/grill-with-docs` and `/improve-codebase-architecture`) adds terms lazily when they actually get resolved — append to `CONCEPTS.md` rather than creating a new `CONTEXT.md`.

## File structure

```
/
├── CONCEPTS.md              ← glossary (CONTEXT.md equivalent)
├── AGENTS.md                ← agent instructions (CLAUDE.md is a symlink to it)
├── docs/
│   ├── design/              ← architectural decisions (ADR equivalent)
│   │   ├── execution-strategy.md
│   │   ├── model-routing.md
│   │   └── translation-pipeline.md
│   └── solutions/           ← documented past problems, by category
│       ├── conventions/
│       ├── integration-issues/
│       └── testing/
└── src/
```

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `CONCEPTS.md`. Don't drift to synonyms the glossary explicitly avoids — "Native Messages", "Responses Translation", and "Chat Completions Fallback" are the strategy names; "proxy boundary" and "translation policy" are the boundary terms.

If the concept you need isn't in the glossary yet, that's a signal — either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag design-doc conflicts

If your output contradicts a decision recorded in `docs/design/`, surface it explicitly rather than silently overriding:

> _Contradicts `docs/design/model-routing.md` (fallback ordering) — but worth reopening because…_

Architectural changes update the relevant design doc in the same change (see `AGENTS.md`).
