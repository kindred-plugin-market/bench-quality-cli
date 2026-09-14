# Diagnostics and recovery

Every failure prints a stable code. `bench-quality doctor --json` reports the
same facts non-interactively (it exits non-zero when it finds an error-level
finding, which makes it usable as a CI gate).

## Hook-side codes

| Code | Meaning | What to do |
| ---- | ------- | ---------- |
| `NODE_VERSION_UNSUPPORTED` | the runtime is below `>=24.15.0` | switch to the version in `.node-version` |
| `NODE_NOT_FOUND` | no usable `node` on `PATH` and no version-manager match | run git from a shell where `node -v` works, or install the pinned version |
| `LEFTHOOK_NOT_INSTALLED` | `node_modules/lefthook` is missing | run the package manager install (`pnpm install`) |
| `HOOKS_NOT_WIRED` | `core.hooksPath` is not `.husky` (typical on a fresh clone) | `pnpm hooks:install` |
| `PARTIALLY_STAGED_FILE` | a file is staged *and* has further unstaged edits | stage the whole file or stash the rest, then commit again |
| `GATE_MISSING` | the change dispatcher referenced a guard that is not installed | re-run `update`; the scope belongs to a feature that is not enabled |

## Generator-side codes

| Code | Meaning | What to do |
| ---- | ------- | ---------- |
| `INVALID_JSON` / `INVALID_YAML` | the file exists but cannot be parsed | fix it by hand; nothing was written |
| `EMPTY_EXISTING_LEFTHOOK_CONFIG` | `lefthook.yml` is empty or comment-only | restore it from git or delete it deliberately |
| `LEFTHOOK_ROOT_MUST_BE_MAPPING` | the document is a list or scalar | restore it from git |
| `INVALID_CONFIG` / `UNKNOWN_PROFILE` / `UNKNOWN_FEATURE` | bad author config or flag value | see the printed list of valid values |
| `PROFILE_REQUIREMENTS_MISSING` | the chosen profile does not describe this repository | point `--target` at the right checkout, or pick another profile |
| `FILE_DRIFT` | a managed file differs from what we wrote | restore it from git, or `update --accept-drift` (original bytes are backed up) |
| `INVALID_MANIFEST` | `.bench-quality.json` is unreadable or from another schema | use the matching generator version, or delete it *deliberately* |
| `GIT_REPO_REQUIRED` | the target is not a git repository | `git init`, or pass `--target` at the checkout |
| `INVALID_TARGET` | the target is not the repository root | re-run with `--target <repo root>` |
| `PATH_IS_SYMLINK` / `PATH_OUTSIDE_TARGET` | a managed path escapes the repository | replace the symlink with a real file/directory |
| `REPO_LOCKED` | another generator process holds the lock | wait; or, when the owning process is gone, `doctor --clear-stale-lock` |
| `RECOVERY_REQUIRED` | a previous batch stopped mid-write | `doctor --recover` |
| `RECOVERY_CONFLICT` | a file changed after the interrupted batch | reconcile by hand using the batch backup directory; the journal is kept |
| `WRITE_FAILED` | a write failed; the batch was rolled back automatically | inspect `--dry-run` output and the backups |
| `TEMPLATE_MISSING` | the installation is incomplete | reinstall from a verified tarball |

## YAML 1.1 tags

`js-yaml` 5 uses the YAML 1.2 core schema, so explicit YAML 1.1 tags
(`!!binary`, `!!set`, `!!timestamp`) are no longer accepted in `lefthook.yml`.
They abort the run with a hint instead of being coerced. Quote or replace the
value by hand:

```yaml
# before (rejected)
when: !!timestamp 2026-09-14
# after
when: "2026-09-14"
```

Plain scalars are safe: `on`/`off`/`yes`/`no`, leading zeros, `1e3`, `0x1f`,
`0o17`, merge keys and quoted values all parse exactly as they did with
js-yaml 4.3.2. Values that a YAML 1.1 parser would misread (`on`, bare dates) are
now written quoted — the value is unchanged.

## pnpm 12 and dependency build scripts

pnpm 12 fails an install with `ERR_PNPM_IGNORED_BUILDS` while a dependency build
script is neither approved nor denied. lefthook ships a postinstall that would
install its own hooks over `.husky`, so the profiles write the denial explicitly:

```yaml
allowBuilds:
  lefthook: false
```

A value that is already there with a different setting is preserved and
reported — the generator never overwrites your choice.

## Recovery model

State lives in `<git-common-dir>/bench-quality-cli/` (shared by linked
worktrees):

```
lock.json                     exclusive write lock (pid + host + start time)
journal.json                  write-ahead record of the running batch
backups/<batchId>/<path>      original bytes of everything the batch touched
backups/<batchId>/removed/    retired artifacts ("moved to trash", not deleted)
```

`doctor --recover` classifies each file of the interrupted batch:

- content still equals the recorded pre-state → not touched,
- content equals this batch's output → restored from the backup,
- anything else → conflict: the file is left alone and the journal is kept.

Nothing is deleted with `rm`: retired artifacts and rollback leftovers are moved
into the backup directory.
