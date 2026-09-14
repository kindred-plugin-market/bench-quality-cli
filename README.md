# bench-quality-cli

Vendoring-based quality-gate generator for Bench repos.

`npx bench-quality-cli init` writes opt-in commit hooks / guards **into the
consumer repo** (its own `scripts/`, `.husky/`, `lefthook.yml`, and
`devDependencies`). Once generated, those artifacts are committed to the
consumer's git — so **this generator repo can be deleted without breaking any
already-initialized project** (delete-safe by design).

## Why a generator, not a runtime library

A runtime dependency would break consumers the moment this repo vanishes. By
vendoring the actual scripts/config into each consumer, the only thing fetched
on demand is the installer itself — and that is only needed at `init` time.

The trade-off: vendored scripts don't auto-update. Mitigate with
`npx bench-quality-cli update` (re-vendors selected features) or by bumping the
version marker in the generated files.

## Usage

```bash
# Interactive: pick features from a prompt
npx bench-quality-cli init

# Non-interactive: choose exactly what you want
npx bench-quality-cli init --features commitlint,markdown,bench-guards --yes

# Re-vendor (e.g. after improving a guard upstream)
npx bench-quality-cli update --features bench-guards --yes

# List available features
npx bench-quality-cli list
```

Then commit the generated files:

```bash
git add -A && git commit -m "chore: add Bench quality gates"
```

## How it works

1. **Vendors** feature scripts into `scripts/quality/` (and config files like
   `commitlint.config.js`, `.markdown-link-check.json`).
2. **Injects** `devDependencies` (always `lefthook`, plus per-feature deps).
3. **Merges** `lefthook.yml` — only a managed block
   (`# >>> bench-quality-cli:managed >>>`) is owned; outside edits survive.
4. **Writes** `.husky/pre-commit` and `.husky/commit-msg` (iron-rule form:
   `node node_modules/lefthook/bin/index.js run <hook>`).
5. **Wires** `git config core.hooksPath .husky`.

## Available features

| Feature        | What it adds                                                        |
| -------------- | ------------------------------------------------------------------- |
| `commitlint`   | Conventional-commit linting (`@commitlint/cli`)                     |
| `markdown`     | Markdown dead-link checking (`markdown-link-check`)                 |
| `bench-guards` | Bench-specific guards vendored as `scripts/quality/*.mjs`           |

## Adding a feature

Append an entry to `src/features/index.mjs` describing `deps`, `files`, and
`lefthook` commands, then drop the template(s) under `templates/`. The
generator logic (vendoring, merge, hooks) is generic and needs no change.

## Notes

- The generated `.husky` hooks resolve `node` from fnm default first, then
  common paths, because git hooks run in a stripped environment.
- `lefthook` is invoked via `node_modules/lefthook/bin/index.js` — never
  `node_modules/.bin/lefthook` (that is a shell wrapper).
