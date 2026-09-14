// .husky hook bodies.
//
// Iron rule: lefthook is invoked as `node node_modules/lefthook/bin/index.js run
// <hook>`; `node_modules/.bin/lefthook` is a shell wrapper and breaks under
// `node`. The bodies are produced here and written by the plan/apply pair so a
// re-run can tell "our previous content" from "a local edit".
export const HOOK_FILES = [
  { relPath: ".husky/pre-commit", hook: "pre-commit" },
  { relPath: ".husky/commit-msg", hook: "commit-msg", passArg: true },
];

const BODY = `#!/usr/bin/env sh
set -e
FNM_DEFAULT="$(command -v fnm >/dev/null 2>&1 && fnm default 2>/dev/null)"
FNM_NODE_BIN="$HOME/.local/share/fnm/node-versions/$FNM_DEFAULT/installation/bin"
BASE_TOOLS="$HOME/.hermes/node/bin:$HOME/.local/bin:$HOME/.cargo/bin:/usr/local/bin:/opt/homebrew/bin"
if [ -n "$FNM_DEFAULT" ] && [ -d "$FNM_NODE_BIN" ]; then
  export PATH="$FNM_NODE_BIN:$BASE_TOOLS:$PATH"
else
  export PATH="$BASE_TOOLS:$PATH"
fi
node node_modules/lefthook/bin/index.js run %HOOK%%ARG%
`;

export function hookContent({ hook, passArg = false }) {
  return BODY.replace("%HOOK%", hook).replace("%ARG%", passArg ? ' "$1"' : "");
}

export function planHooks() {
  return HOOK_FILES.map((file) => ({
    relPath: file.relPath,
    content: hookContent(file),
    mode: 0o755,
    kind: "hook",
  }));
}
