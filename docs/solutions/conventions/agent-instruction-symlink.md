---
title: AGENTS.md is the single source; CLAUDE.md is a git symlink
date: 2026-05-22
category: conventions
module: documentation
problem_type: convention
component: documentation
severity: low
applies_when:
  - "Repo carries both AGENTS.md and CLAUDE.md"
  - "Editing project-wide agent instructions"
  - "Running /init, /compound discoverability edits, or any automated writer that targets CLAUDE.md"
  - "Adding a new subdirectory that needs its own scoped agent instructions"
tags: [agents-md, claude-md, symlink, windows, conventions]
---

# AGENTS.md is the single source; CLAUDE.md is a git symlink

## Context

Different agentic tools look for differently-named instruction files
(`AGENTS.md` for Codex/Cursor/general agents, `CLAUDE.md` for Claude Code).
Maintaining independent copies guarantees drift: one file gets the new
architecture note, the other keeps the old release flow, and neither agent
sees the union.

In this repo, before unification, `AGENTS.md` and `CLAUDE.md` had diverged
across multiple commits — same scaffolding, different sections (one carried
`Compatibility Contract` + detailed `Release Automation`, the other carried
`Route File Pattern` + `ModelTransformChain`). Manual sync was already losing.

## Guidance

Keep **one** source of truth (`AGENTS.md`) and make `CLAUDE.md` a git
symlink (mode `120000`) pointing at it. The link is tracked in git as a
`120000`-mode blob whose content is the target path — every clone gets the
same link, and on Windows it materializes as a real symlink as long as
`core.symlinks=true` is enabled.

**Golden rule**: edit `AGENTS.md` only. Never `Write`/`Edit` `CLAUDE.md` —
on Windows that replaces the symlink with a regular file and you're back to
two diverging copies.

The exact Windows-safe recreation recipe, including the command to
rematerialize all tracked `**/CLAUDE.md` symlinks after enabling
`core.symlinks`, lives at the bottom of `AGENTS.md` itself (so future agents
discover it when reading the file they're allowed to edit). This doc focuses
on **why** and on the footguns to avoid; the recipe is not re-hosted here to
prevent drift between the two.

### Subfolder scope

The convention applies recursively. **Any** `CLAUDE.md` in any subdirectory
must be a symlink to the `AGENTS.md` in the **same** directory (not a path
that climbs back to the root) — that way nested directories can carry their
own scoped instructions without an accidental cross-scope link.

Verify with:

```bash
git ls-files -s '**/CLAUDE.md' 'CLAUDE.md'   # all entries must be mode 120000
```

## Why This Matters

- **No drift.** Two agents reading two filenames see identical bytes — the
  filesystem guarantees it, no review process required.
- **No tooling rewrites needed.** Claude Code keeps reading `CLAUDE.md`,
  Codex/Cursor keep reading `AGENTS.md`. The convention is invisible to the
  agents themselves.
- **Stays correct under `/init`-style automation.** Skills that target
  `CLAUDE.md` would otherwise silently fork the files; the symlink survives
  any `Edit` (which follows the link) but breaks under `Write` (which
  replaces the inode). The banner at the top of `AGENTS.md` trains future
  agents not to use `Write` on the link side.

## When to Apply

- Whenever a repo needs to be readable by **more than one** agentic tool
  that expects a differently-named instructions file.
- When `/init`, `/compound`, or any other skill is about to write to
  `CLAUDE.md` — redirect the write to `AGENTS.md` instead.
- When adding nested per-directory agent instructions — symlink the
  `CLAUDE.md` in that directory to the `AGENTS.md` in the **same**
  directory.

## Examples

### Wrong — `ln -s` or `cp` on Windows

```bash
# Git Bash on Windows silently makes a COPY, not a symlink — git sees a
# regular file. The two files immediately start drifting again.
ln -s AGENTS.md CLAUDE.md

# Same problem — replaces the link with a regular file.
cp AGENTS.md CLAUDE.md
```

### Wrong — here-string with `git hash-object`

```bash
# `<<<` appends a trailing \n to stdin. The blob becomes "AGENTS.md\n",
# and the symlink target literally points to a path called "AGENTS.md\n"
# — broken on every platform.
git update-index --add --cacheinfo \
  120000,$(git hash-object -w --stdin <<< 'AGENTS.md'),CLAUDE.md
```

The correct recipe (using `printf` with no trailing newline, then
`git update-index --cacheinfo 120000,...`, then `git checkout --`) lives at
the bottom of the repo's `AGENTS.md`.

## Related

- Root `AGENTS.md` — carries the convention banner and the recreation recipe.
- Sibling repo `Q:/repos/thoughtscape/ob-flow` — same convention with nested
  `**/CLAUDE.md` symlinks, documented in `.claude/rules/symlinks.md`.
