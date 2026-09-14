// Consumer profiles (QG-03).
//
// A profile is what a *repository kind* needs, expressed as data:
//   - features:      registry ids the profile turns on by default
//   - requires:      paths that must exist for the profile to make sense
//                    (checked fail-closed when the profile is chosen explicitly)
//   - scripts:       project entries to add (never overwriting a human's script)
//   - workspaceKeys: pnpm-workspace keys the toolchain depends on
//
// `bench-guards` is deliberately NOT applied to repositories that have no Rust
// or host tree: its guards stay silent there, but installing them would only add
// noise and runtime cost (QG-03: "不再向无 Rust/宿主目录的工程默认投放全套宿主检查").
export const profiles = [
  {
    id: "node-tool",
    description: "Node-only tool/library repository (generator repositories)",
    features: ["commitlint", "markdown"],
    requires: [],
    scripts: {
      "hooks:install": "node scripts/quality/install-hooks.mjs",
      "check:precommit": "node node_modules/lefthook/bin/index.js run pre-commit",
      "check:md-links": "node scripts/quality/check-markdown-links.mjs --all",
      "test": "node --test \"tests/**/*.test.mjs\"",
    },
    workspaceKeys: { allowBuilds: { lefthook: false } },
  },
  {
    id: "tauri-host",
    description: "Tauri host application (frontend + Rust workspace)",
    features: ["commitlint", "markdown", "bench-guards"],
    requires: ["src-tauri"],
    scripts: {
      "hooks:install": "node scripts/quality/install-hooks.mjs",
      "check:precommit": "node node_modules/lefthook/bin/index.js run pre-commit",
      "check:changed-paths": "node scripts/quality/check-changed-paths.mjs",
      "check:md-links": "node scripts/quality/check-markdown-links.mjs --all",
    },
    workspaceKeys: { allowBuilds: { lefthook: false } },
  },
  {
    id: "plugin-market",
    description: "Marketplace meta-repository (extension sources, no host tree)",
    features: ["commitlint", "markdown"],
    requires: ["extensions"],
    scripts: {
      "hooks:install": "node scripts/quality/install-hooks.mjs",
      "check:precommit": "node node_modules/lefthook/bin/index.js run pre-commit",
      "check:md-links": "node scripts/quality/check-markdown-links.mjs --all",
    },
    workspaceKeys: { allowBuilds: { lefthook: false } },
  },
  {
    id: "data-market",
    description: "Data-only repository (JSON catalogues and index generators)",
    features: ["commitlint", "markdown"],
    requires: [],
    scripts: {
      "hooks:install": "node scripts/quality/install-hooks.mjs",
      "check:precommit": "node node_modules/lefthook/bin/index.js run pre-commit",
    },
    workspaceKeys: { allowBuilds: { lefthook: false } },
  },
];

export const DEFAULT_PROFILE = "node-tool";

export function findProfile(id) {
  return profiles.find((profile) => profile.id === id) ?? null;
}

/** Profile ids whose `requires` entries do not exist in the consumer. */
export function missingRequirements(profile, { exists }) {
  return (profile.requires ?? []).filter((entry) => !exists(entry));
}
