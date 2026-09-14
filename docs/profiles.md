# Profiles and configuration

## Profiles

A profile is what a *kind of repository* needs, expressed as data. Choosing one
with `--profile` is an explicit statement: if a required path is missing the run
stops before writing anything (`PROFILE_REQUIREMENTS_MISSING`).

| Profile | For | Features | Requires | Project entries |
| ------- | --- | -------- | -------- | --------------- |
| `node-tool` | Node-only tool or library repository | `commitlint`, `markdown` | — | `hooks:install`, `check:precommit`, `check:md-links`, `test` |
| `tauri-host` | Tauri host application (frontend + Rust workspace) | `commitlint`, `markdown`, `bench-guards` | `src-tauri` | plus `check:changed-paths` |
| `plugin-market` | Marketplace meta-repository | `commitlint`, `markdown` | `extensions` | `hooks:install`, `check:precommit`, `check:md-links` |
| `data-market` | Data-only repository (JSON catalogues, index generators) | `commitlint`, `markdown` | — | `hooks:install`, `check:precommit` |

Every profile also writes `allowBuilds.lefthook: false` into
`pnpm-workspace.yaml` and installs the baseline pre-commit wiring
(`partial-staging`, `whitespace`) plus `scripts/quality/install-hooks.mjs`.

`bench-guards` is deliberately **not** applied to repositories without a host
tree: the i18n/docs/CI/Rust guards stay silent there, and `ci-platforms`
enforces a macOS/Windows-only policy that a Linux CI would violate.

## Features

| Feature | Adds | devDependencies |
| ------- | ---- | --------------- |
| `commitlint` | `commitlint.config.js` + `commit-msg` entry | `@commitlint/cli`, `@commitlint/config-conventional` (both `^21.2.2`) |
| `markdown` | `.markdown-link-check.json`, the cross-platform runner and the `markdown-links` entry | `markdown-link-check` (`^3`) |
| `bench-guards` | `check-i18n-guards`, `check-docs-consistency`, `check-ci-platforms`, `check-workflow-hygiene`, `check-rust-cfg-hygiene`, `check-rust-crates`, `check-changed-paths` | `typescript` (`^6.0.3`) |

`lefthook` (`^2.1.14`) is installed by every profile.

## Author configuration: `bench-quality.config.json`

```json
{
  "profile": "tauri-host",
  "features": ["commitlint", "markdown", "bench-guards"],
  "excludeFeatures": ["markdown"],
  "acceptDrift": false
}
```

| Key | Meaning |
| --- | ------- |
| `profile` | default profile id (flags win) |
| `features` | feature ids to request instead of the profile default |
| `excludeFeatures` | ids subtracted from whatever was requested (profile, file or `--yes`) |
| `acceptDrift` | adopt locally edited managed files without passing `--accept-drift` |

Unknown keys, wrong types or an unknown profile abort the run
(`INVALID_CONFIG` / `UNKNOWN_PROFILE`). The file is only ever read, never
rewritten.

## Generated state: `.bench-quality.json`

Records the generator version, the profile and features, the hash of every file
we wrote, the managed `devDependencies`/`scripts`/workspace keys, the hook
wiring (including the value that existed *before* the generator ran) and the
batch id/timestamps. It is the input for drift detection, for `doctor`, and for
`remove` — nothing else may delete your files.

Do not edit it by hand; if it is unreadable the CLI stops with
`INVALID_MANIFEST` rather than guessing.

## Precedence

```
--features / --profile  >  bench-quality.config.json  >  profile defaults  >  (manifest state for update)
```

`init` and `update` never *drop* features: they union what is already recorded
with what you request. Use `remove --features <id>` for that.
