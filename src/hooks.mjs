import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

// Hooks MUST invoke lefthook via node_modules/lefthook/bin/index.js — never
// node_modules/.bin/lefthook (that is a shell wrapper and throws SyntaxError).
// Node is resolved from fnm default first, then common install locations,
// because git hooks run in a stripped environment where node may be absent.
const PRE_COMMIT = `#!/usr/bin/env sh
set -e
FNM_DEFAULT="$(command -v fnm >/dev/null 2>&1 && fnm default 2>/dev/null)"
FNM_NODE_BIN="$HOME/.local/share/fnm/node-versions/$FNM_DEFAULT/installation/bin"
BASE_TOOLS="$HOME/.hermes/node/bin:$HOME/.local/bin:$HOME/.cargo/bin:/usr/local/bin:/opt/homebrew/bin"
if [ -n "$FNM_DEFAULT" ] && [ -d "$FNM_NODE_BIN" ]; then
  export PATH="$FNM_NODE_BIN:$BASE_TOOLS:$PATH"
else
  export PATH="$BASE_TOOLS:$PATH"
fi
node node_modules/lefthook/bin/index.js run pre-commit
`;

const COMMIT_MSG = `#!/usr/bin/env sh
set -e
FNM_DEFAULT="$(command -v fnm >/dev/null 2>&1 && fnm default 2>/dev/null)"
FNM_NODE_BIN="$HOME/.local/share/fnm/node-versions/$FNM_DEFAULT/installation/bin"
BASE_TOOLS="$HOME/.hermes/node/bin:$HOME/.local/bin:$HOME/.cargo/bin:/usr/local/bin:/opt/homebrew/bin"
if [ -n "$FNM_DEFAULT" ] && [ -d "$FNM_NODE_BIN" ]; then
  export PATH="$FNM_NODE_BIN:$BASE_TOOLS:$PATH"
else
  export PATH="$BASE_TOOLS:$PATH"
fi
node node_modules/lefthook/bin/index.js run commit-msg "$1"
`;

export async function writeHooks(target) {
  const dir = join(target, ".husky");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "pre-commit"), PRE_COMMIT, { mode: 0o755 });
  await writeFile(join(dir, "commit-msg"), COMMIT_MSG, { mode: 0o755 });
  console.log("  + wrote .husky/pre-commit and .husky/commit-msg");
}
