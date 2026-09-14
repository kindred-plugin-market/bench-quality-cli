// Feature registry. Each feature declares:
//  - deps.dev: devDependencies to inject into the consumer's package.json
//  - files:    templates to vendor into the consumer repo
//  - lefthook: { "<hook>": { commands: [...], scripts: [...] } }
//      commands: [{ name, run, root?, stage_fixed? }]   -> `commands:` block
//      scripts:  [{ name, runner, only?, stage_fixed? }]  -> `scripts:` block
//
// Add a new feature by appending an entry here + its template files under
// templates/. The rest of the generator (vendoring, merge, hooks) is generic.

export const features = [
  {
    id: "commitlint",
    description: "Conventional-commit message linting via @commitlint/cli",
    deps: { dev: { "@commitlint/cli": "^19", "@commitlint/config-conventional": "^19" } },
    files: [{ from: "commitlint.config.js", to: "commitlint.config.js" }],
    lefthook: {
      "commit-msg": {
        commands: [
          { name: "commitlint", run: "pnpm exec commitlint --edit {1}", fail_text: "Commit message failed conventional-commits lint" },
        ],
      },
    },
  },
  {
    id: "markdown",
    description: "Markdown dead-link checking via markdown-link-check",
    deps: { dev: { "markdown-link-check": "^3" } },
    files: [{ from: ".markdown-link-check.json", to: ".markdown-link-check.json" }],
    lefthook: {
      "pre-commit": {
        commands: [
          {
            name: "markdown-links",
            root: "git",
            run: "pnpm exec markdown-link-check --config .markdown-link-check.json --quiet {staged_files}",
          },
        ],
      },
    },
  },
  {
    id: "bench-guards",
    description:
      "Bench-specific guards (i18n / docs / ci-platforms / workflow / rust-cfg / rust-crates) + whitespace fixer, vendored as scripts",
    deps: { dev: { typescript: "^5" } },
    files: [
      { from: "guards/check-i18n-guards.mjs", to: "scripts/quality/check-i18n-guards.mjs" },
      { from: "guards/check-docs-consistency.mjs", to: "scripts/quality/check-docs-consistency.mjs" },
      { from: "guards/check-ci-platforms.mjs", to: "scripts/quality/check-ci-platforms.mjs" },
      { from: "guards/check-workflow-hygiene.mjs", to: "scripts/quality/check-workflow-hygiene.mjs" },
      { from: "guards/check-rust-cfg-hygiene.mjs", to: "scripts/quality/check-rust-cfg-hygiene.mjs" },
      { from: "guards/check-rust-crates.mjs", to: "scripts/quality/check-rust-crates.mjs" },
      { from: "guards/fix-staged-whitespace.mjs", to: "scripts/quality/fix-staged-whitespace.mjs" },
    ],
    lefthook: {
      "pre-commit": {
        commands: [
          {
            name: "whitespace",
            run: "node scripts/quality/fix-staged-whitespace.mjs",
            stage_fixed: true,
          },
        ],
        scripts: [
          { name: "i18n-guards", runner: "node scripts/quality/check-i18n-guards.mjs", only: ["src/**", "extensions/**"] },
          {
            name: "docs-consistency",
            runner: "node scripts/quality/check-docs-consistency.mjs",
            only: ["docs/**", "src/features/**", "extensions/**", "AGENTS.md", "README.md"],
          },
          { name: "ci-platforms", runner: "node scripts/quality/check-ci-platforms.mjs", only: [".github/workflows/**"] },
          { name: "workflow-hygiene", runner: "node scripts/quality/check-workflow-hygiene.mjs", only: [".github/workflows/**"] },
          {
            name: "rust-cfg-hygiene",
            runner: "node scripts/quality/check-rust-cfg-hygiene.mjs --fix",
            only: ["src-tauri/**/*.rs"],
            stage_fixed: true,
          },
          { name: "rust-crates", runner: "node scripts/quality/check-rust-crates.mjs", only: ["src-tauri/**/*.rs"] },
        ],
      },
    },
  },
];
