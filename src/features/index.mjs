// Feature registry. Each feature declares:
//  - deps.dev: devDependencies to inject into the consumer's package.json
//  - files:    templates to vendor into the consumer repo
//  - lefthook: { "<hook>": { commands: [...], scripts: [...] } }
//      commands: [{ name, glob?, exclude?, run, priority?, stage_fixed?, fail_text? }]
//
// Hook wiring rules (verified against lefthook 2.1.14, see evidence/CLI/C03):
//   - `commands` + `glob` is the only reliable file gate. `scripts` + `only`
//     never fires for nested paths, so it is not used any more.
//   - glob shapes that actually match: "*.md" (any depth), "src/**",
//     ".github/workflows/**", bare root names ("README.md"). A pattern like
//     "src-tauri/**/*.rs" does NOT match "src-tauri/build.rs" — avoid it.
//   - lefthook drops deleted/renamed paths from every file list, so deletions
//     are covered by the always-on `changed-paths` dispatcher instead.
//   - Anything that rewrites the worktree/ index chains
//     `guard-partial-staging.mjs && ...` so the protection can never be
//     reordered by lefthook's parallel scheduling.
export const features = [
  {
    id: "commitlint",
    description: "Conventional-commit message linting via @commitlint/cli",
    deps: { dev: { "@commitlint/cli": "^19", "@commitlint/config-conventional": "^19" } },
    files: [{ from: "commitlint.config.js", to: "commitlint.config.js" }],
    lefthook: {
      "commit-msg": {
        commands: [
          {
            name: "commitlint",
            run: "pnpm exec commitlint --edit {1}",
            fail_text: "Commit message failed conventional-commits lint",
          },
        ],
      },
    },
  },
  {
    id: "markdown",
    description: "Markdown dead-link checking via markdown-link-check",
    deps: { dev: { "markdown-link-check": "^3" } },
    files: [
      { from: ".markdown-link-check.json", to: ".markdown-link-check.json" },
      { from: "guards/git-changes.mjs", to: "scripts/quality/git-changes.mjs" },
      { from: "guards/check-markdown-links.mjs", to: "scripts/quality/check-markdown-links.mjs" },
    ],
    lefthook: {
      "pre-commit": {
        commands: [
          {
            name: "markdown-links",
            glob: "*.md",
            priority: 10,
            run: "node scripts/quality/check-markdown-links.mjs {staged_files}",
            fail_text: "Dead link found in a staged markdown file",
          },
        ],
      },
    },
  },
  {
    id: "bench-guards",
    description:
      "Bench-specific guards (i18n / docs / ci-platforms / workflow / rust-cfg / rust-crates) + partial-staging protection, vendored as scripts",
    deps: { dev: { typescript: "^5" } },
    files: [
      { from: "guards/check-changed-paths.mjs", to: "scripts/quality/check-changed-paths.mjs" },
      { from: "guards/check-i18n-guards.mjs", to: "scripts/quality/check-i18n-guards.mjs" },
      { from: "guards/check-docs-consistency.mjs", to: "scripts/quality/check-docs-consistency.mjs" },
      { from: "guards/check-ci-platforms.mjs", to: "scripts/quality/check-ci-platforms.mjs" },
      { from: "guards/check-workflow-hygiene.mjs", to: "scripts/quality/check-workflow-hygiene.mjs" },
      { from: "guards/check-rust-cfg-hygiene.mjs", to: "scripts/quality/check-rust-cfg-hygiene.mjs" },
      { from: "guards/check-rust-crates.mjs", to: "scripts/quality/check-rust-crates.mjs" },
      { from: "guards/fix-staged-whitespace.mjs", to: "scripts/quality/fix-staged-whitespace.mjs" },
      { from: "guards/check-markdown-links.mjs", to: "scripts/quality/check-markdown-links.mjs" },
    ],
    lefthook: {
      "pre-commit": {
        commands: [
          {
            name: "changed-paths",
            priority: 1,
            run: "node scripts/quality/check-changed-paths.mjs",
            fail_text: "A deleted or renamed path left its scope unverified",
          },
          {
            name: "partial-staging",
            priority: 2,
            run: "node scripts/quality/guard-partial-staging.mjs",
            fail_text: "Refusing to rewrite a partially staged file",
          },
          {
            name: "whitespace",
            priority: 3,
            run: "node scripts/quality/guard-partial-staging.mjs && node scripts/quality/fix-staged-whitespace.mjs",
            stage_fixed: true,
            fail_text: "Trailing whitespace could not be fixed automatically",
          },
          {
            name: "i18n-guards",
            glob: ["src/**", "extensions/**"],
            priority: 10,
            run: "node scripts/quality/check-i18n-guards.mjs",
            fail_text: "i18n guard failed",
          },
          {
            name: "docs-consistency",
            glob: ["docs/**", "src/features/**", "extensions/**", "README.md", "AGENTS.md"],
            priority: 10,
            run: "node scripts/quality/check-docs-consistency.mjs",
            fail_text: "Feature/docs structure is inconsistent",
          },
          {
            name: "ci-platforms",
            glob: ".github/workflows/**",
            priority: 10,
            run: "node scripts/quality/check-ci-platforms.mjs",
            fail_text: "CI workflow targets a platform outside the supported matrix",
          },
          {
            name: "workflow-hygiene",
            glob: ".github/workflows/**",
            priority: 10,
            run: "node scripts/quality/check-workflow-hygiene.mjs",
            fail_text: "Workflow hygiene check failed",
          },
          {
            name: "rust-cfg-hygiene",
            glob: "src-tauri/**",
            priority: 10,
            run: "node scripts/quality/guard-partial-staging.mjs && node scripts/quality/check-rust-cfg-hygiene.mjs --fix",
            stage_fixed: true,
            fail_text: "cargo cfg hygiene could not be normalized",
          },
          {
            name: "rust-crates",
            glob: "src-tauri/**",
            priority: 10,
            run: "node scripts/quality/check-rust-crates.mjs",
            fail_text: "Rust crate/feature usage violates the guarded-crates policy",
          },
        ],
      },
    },
  },
];
