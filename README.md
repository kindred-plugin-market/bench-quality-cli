# bench-quality-cli

Vendoring-based quality-gate generator for Bench repositories.

`bench-quality init` writes the gates **into the consumer repository** (its own
`scripts/quality/`, `.husky/`, `lefthook.yml`, `package.json` entries and a
`.bench-quality.json` state file) and commits them there. The generator itself is
only needed at that moment: **deleting this repository does not break an
already-initialized project**.

## Requirements

| Tool | Version | Where it is declared |
| ---- | ------- | -------------------- |
| Node | `>=24.15.0` (`26.8.2` for local development and the main CI job) | `package.json` `engines.node`, `.node-version` |
| pnpm | `12.4.2` | `package.json` `packageManager`, `pnpm-workspace.yaml` |

The bin entry refuses to run on an older runtime with `NODE_VERSION_UNSUPPORTED`
instead of failing later with a syntax error.

## Installation source (verified)

`bench-quality-cli` is **not published to npm** (`npm view bench-quality-cli`
returns 404). Do not use `npx bench-quality-cli` — that name is unclaimed.
Install only from a verified source:

```bash
# 1. Clone this repository (SSH) and run from the checkout
git clone git@github.com:kindred-plugin-market/bench-quality-cli.git
node bench-quality-cli/bin/index.mjs init --profile node-tool

# 2. Or pin a commit: download the GitHub tarball and verify its SHA-256
#    against the digest published in the repository's release notes
#    (see "Releases" — every release lists the tarball SHA-256).
curl -fsSL https://github.com/kindred-plugin-market/bench-quality-cli/archive/<full-commit-sha>.tar.gz -o bqc.tar.gz
shasum -a 256 bqc.tar.gz   # compare with the release-notes digest
tar -xzf bqc.tar.gz
node bench-quality-cli-<full-commit-sha>/bin/index.mjs init --profile node-tool
```

Rules that keep this verifiable:

| Rule | Reason |
| ---- | ------ |
| Never `npx bench-quality-cli` until a real npm package exists | the name is unclaimed; anything could be published there |
| Pin a **full commit SHA** (or a tag whose notes carry the tarball digest) | mutable branch refs cannot be audited later |
| Prefer the pinned-tarball route for CI and cross-repo automation | no git history needed, digest-checkable |
| npm publishing stays blocked until trusted publishing + provenance is set up | avoids leaking publish credentials during the current hardening batch |

Consumers record the generator version + file hashes in `.bench-quality.json`,
so an installed project can always tell which generator state it was vendored
from (`doctor` flags any drift).

## Usage

```bash
# Install into the current repository root, using a profile
node bin/index.mjs init --profile node-tool

# Pick features explicitly
node bin/index.mjs init --features commitlint,markdown

# Preview first: prints the exact plan and writes nothing
node bin/index.mjs init --profile tauri-host --dry-run

# Re-vendor after the generator changed (keeps the enabled feature set)
node bin/index.mjs update

# Adopt files that were edited locally (originals are backed up first)
node bin/index.mjs update --accept-drift

# Drop a feature and its artifacts
node bin/index.mjs remove --features markdown

# Inspect / repair
node bin/index.mjs doctor --json
node bin/index.mjs doctor --recover        # restore an interrupted batch
node bin/index.mjs list
```

`update` without `--features` is additive: it keeps exactly what is enabled
(`remove` is the only way to drop something). `init` and `update` require the
target to be the **repository root**; generated hooks wired from a subdirectory
would never run, so that case fails closed.

Review and stage the result explicitly — do not blanket-add:

```bash
git status
git diff
git add .husky scripts/quality lefthook.yml package.json pnpm-workspace.yaml .bench-quality.json commitlint.config.js
git commit -m "chore: add Bench quality gates"
```

## Profiles

A profile describes what a *kind of repository* needs (features, required paths,
project entries, workspace keys). See [docs/profiles.md](docs/profiles.md) for
the matrix. `--profile` (or `bench-quality.config.json`) is explicit: choosing a
profile whose required paths do not exist fails closed
(`PROFILE_REQUIREMENTS_MISSING`) and writes nothing.

## Configuration

| File | Owner | Purpose |
| ---- | ----- | ------- |
| `bench-quality.config.json` | you | profile, features, `excludeFeatures`, `acceptDrift`. Only ever read. |
| `.bench-quality.json` | generator | what was installed, with hashes, managed keys and the batch id. Never edit by hand. |

Command line flags win over the file, the file wins over profile defaults. Both
are described in [docs/profiles.md](docs/profiles.md).

## What gets generated

| Artifact | Managed by the generator | Notes |
| -------- | ------------------------ | ----- |
| `lefthook.yml` | only the named entries (a `managed-entries` comment lists them) | your own commands (`prettier`, `frontend`, `backend`, …) are preserved |
| `scripts/quality/*.mjs` | whole files | hashes recorded; a local edit is reported, never overwritten |
| `.husky/pre-commit`, `.husky/commit-msg` | whole files | POSIX `sh`; resolve `node` without requiring a specific version manager |
| `package.json` | only the recorded `devDependencies` and `scripts` | your ranges, scripts and lifecycle hooks win |
| `pnpm-workspace.yaml` | only `allowBuilds.lefthook` | pnpm 12 aborts an install while a dependency build script is unapproved |
| `.markdown-link-check.json`, `commitlint.config.js` | whole files | |

Everything else in those files stays byte-identical apart from YAML
re-serialisation of `lefthook.yml`.

## Hook behaviour

`pre-commit` runs, in priority order:

1. `changed-paths` — re-runs the gates of a scope whose paths were **deleted or
   renamed** (lefthook filters deleted paths out of every file list, so this is
   the only reliable channel).
2. `partial-staging` — refuses the commit when a file is staged *and* has further
   unstaged edits. This runs from the hook body, before lefthook, because
   lefthook stashes unstaged changes before running commands.
3. `whitespace` — fixes trailing whitespace and re-stages what it changed
   (chained behind the same guard).
4. feature and repository commands (`i18n-guards`, `docs-consistency`,
   `ci-platforms`, `workflow-hygiene`, `rust-cfg-hygiene`, `rust-crates`,
   `markdown-links`, …), gated by `glob`.

`commit-msg` runs commitlint (Conventional Commits).

Node is resolved as: an already working `node` on `PATH` first, then version
managers as optional candidates driven by `.node-version`/`.nvmrc`. Failures
carry stable codes: `NODE_NOT_FOUND`, `LEFTHOOK_NOT_INSTALLED`.

## Maintenance flows

| Situation | Command |
| --------- | ------- |
| Fresh clone, hooks not wired (`HOOKS_NOT_WIRED`) | `pnpm hooks:install` (also runs from `prepare`) |
| The generator changed upstream | `node bin/index.mjs update`, then review the diff |
| A managed file was edited locally (`FILE_DRIFT`) | restore it from git, or `update --accept-drift` (backup kept) |
| A run was interrupted | `node bin/index.mjs doctor --recover` |
| A stale lock is left behind | `node bin/index.mjs doctor --clear-stale-lock` |
| Anything looks wrong | `node bin/index.mjs doctor --json` |

State (lock, journal, per-batch backups) lives in
`<git-common-dir>/bench-quality-cli/`, shared by linked worktrees and never
committed. See [docs/troubleshooting.md](docs/troubleshooting.md) for the full
diagnostic list.

## Development (this repository)

```bash
pnpm install          # also wires .husky through the generated installer
pnpm test             # node:test suites, including real lefthook hook runs
pnpm run check:syntax # node --check sweep with the current runtime
pnpm run verify       # check:syntax + tests
pnpm run check:md-links
```

This repository uses the generator on itself (`init --profile node-tool`), so
the gates above are the same ones consumers get. CI
(`.github/workflows/quality.yml`) runs read-only checks on macOS with Node
26.8.2 and 24.15.0 and a portable subset on Windows; no job publishes or writes.

## Notes

- lefthook is invoked as `node node_modules/lefthook/bin/index.js run <hook>`;
  `node_modules/.bin/lefthook` is a shell wrapper that breaks under `node`.
- The generator never runs `git add`, `git commit` or `git push`, and never
  publishes a package. Staging and committing stay manual.
