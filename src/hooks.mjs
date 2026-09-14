// .husky hook bodies.
//
// Iron rule: lefthook is invoked as `node node_modules/lefthook/bin/index.js run
// <hook>`; `node_modules/.bin/lefthook` is a shell wrapper and breaks under
// `node`.
//
// Node addressing rules (QG-01 / R4):
//   - an already working `node` always wins — git hooks run in a stripped
//     environment and we must not "fix" a working setup;
//   - a missing fnm/asdf/nvm must never abort the hook: version managers are
//     probed as optional candidates, driven by the project's own version file;
//   - no personal absolute path (a specific user's home layout) is hardcoded,
//     and nothing is written to the user's global configuration;
//   - every failure prints a stable diagnostic code (NODE_NOT_FOUND,
//     LEFTHOOK_NOT_INSTALLED) instead of a bare shell error.
export const HOOK_FILES = [
  { relPath: ".husky/pre-commit", hook: "pre-commit" },
  { relPath: ".husky/commit-msg", hook: "commit-msg", passArg: true },
];

const BODY = `#!/usr/bin/env sh
# Managed by bench-quality-cli (init/update). Do not edit by hand.
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$repo_root"

# Strip nothing from PATH, then make the standard tool locations reachable:
# git hooks run with a stripped environment (GUI clients, IDEs) where neither
# the package manager nor cargo may be found. These are the conventional
# locations, not a specific machine's layout; machine-specific extras belong in
# .husky/hooks.env (optional, sourced below, never managed by the generator).
for tool_dir in "$HOME/.local/bin" "$HOME/.cargo/bin" /usr/local/bin /opt/homebrew/bin; do
  if [ -d "$tool_dir" ]; then
    PATH="$PATH:$tool_dir"
  fi
done
export PATH

if [ -f .husky/hooks.env ]; then
  # shellcheck disable=SC1091
  . ./.husky/hooks.env
fi

if ! command -v node >/dev/null 2>&1; then
  pinned=""
  if [ -f .node-version ]; then pinned=$(tr -d '[:space:]' < .node-version); fi
  if [ -z "$pinned" ] && [ -f .nvmrc ]; then pinned=$(tr -d 'v[:space:]' < .nvmrc); fi
  for candidate in \\
    "$HOME/.local/share/fnm/node-versions/$pinned/installation/bin" \\
    "$HOME/.nvm/versions/node/v$pinned/bin" \\
    "$HOME/.asdf/installs/nodejs/$pinned/bin" \\
    "$HOME/.volta/bin" \\
    /opt/homebrew/opt/node/bin \\
    /usr/local/opt/node/bin
  do
    if [ -n "$candidate" ] && [ -x "$candidate/node" ]; then
      PATH="$candidate:$PATH"
      export PATH
      break
    fi
  done
fi

if ! command -v node >/dev/null 2>&1; then
  echo "NODE_NOT_FOUND: no usable node on PATH and no version-manager match for .node-version." >&2
  echo "Install Node (see .node-version), or run git from a shell where 'node -v' works." >&2
  exit 1
fi

if [ ! -f node_modules/lefthook/bin/index.js ]; then
  echo "LEFTHOOK_NOT_INSTALLED: node_modules/lefthook/bin/index.js is missing." >&2
  echo "Install the project dependencies (for example 'pnpm install') and commit again." >&2
  exit 1
fi

%GUARD%%EXEC%
`;

// Rationale for running the guard from the hook body rather than from a
// lefthook command: lefthook 2.x stashes unstaged changes before running
// pre-commit commands (verified on 2.1.14 — it calls `git stash create`), so
// inside a command the worktree always looks index-consistent and partial
// staging is undetectable. The hook body runs in the author's real worktree,
// i.e. before any automatic fix can re-stage unreviewed content.
const GUARD = (script) => `# Refuse partial staging before anything may rewrite the worktree.
if [ -f ${script} ]; then
  node ${script} || exit 1
fi

`;

export const PARTIAL_STAGING_GUARD = "scripts/quality/guard-partial-staging.mjs";

export function hookContent({ hook, passArg = false }) {
  const guard = hook === "pre-commit" ? GUARD(PARTIAL_STAGING_GUARD) : "";
  const exec = `exec node node_modules/lefthook/bin/index.js run ${hook}${passArg ? ' "$1"' : ""}`;
  return BODY.replace("%GUARD%", guard).replace("%EXEC%", exec);
}

/** Files the hook bodies/wiring depend on, needed whenever hooks are written. */
export const HOOK_SUPPORT_FILES = [
  { from: "guards/git-changes.mjs", to: "scripts/quality/git-changes.mjs" },
  { from: "guards/guard-partial-staging.mjs", to: PARTIAL_STAGING_GUARD },
  { from: "guards/fix-staged-whitespace.mjs", to: "scripts/quality/fix-staged-whitespace.mjs" },
  // Fresh clones need an install entry: the generator runs once, `.git/config`
  // is not versioned, and without it a reviewer would commit with no gate.
  { from: "scripts/install-hooks.mjs", to: "scripts/quality/install-hooks.mjs" },
];

/**
 * Baseline pre-commit wiring every repository gets, independent of feature
 * choice: refuse partial staging, then fix whitespace (chained so the guard
 * cannot be reordered), in that priority order. Feature-specific gates are
 * declared by the features themselves.
 */
export const BASE_WIRING = {
  id: "quality-core",
  lefthook: {
    "pre-commit": {
      commands: [
        {
          name: "partial-staging",
          priority: 2,
          run: `node ${PARTIAL_STAGING_GUARD}`,
          fail_text: "Refusing to rewrite a partially staged file",
        },
        {
          name: "whitespace",
          priority: 3,
          run: `node ${PARTIAL_STAGING_GUARD} && node scripts/quality/fix-staged-whitespace.mjs`,
          stage_fixed: true,
          fail_text: "Trailing whitespace could not be fixed automatically",
        },
      ],
    },
  },
};

export function planHooks() {
  return HOOK_FILES.map((file) => ({
    relPath: file.relPath,
    content: hookContent(file),
    mode: 0o755,
    kind: "hook",
  }));
}
