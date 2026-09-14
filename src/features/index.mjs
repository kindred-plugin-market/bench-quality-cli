// Feature registry. Each feature declares:
//  - deps.dev: devDependencies to inject into the consumer's package.json
//  - files:    templates to vendor into the consumer repo
//  - lefthook: hook -> [{ name, run, root? }] commands to merge into lefthook.yml
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
      "commit-msg": [{ name: "commitlint", run: "npx commitlint --edit {1}" }],
    },
  },
  {
    id: "markdown",
    description: "Markdown dead-link checking via markdown-link-check",
    deps: { dev: { "markdown-link-check": "^3" } },
    files: [{ from: ".markdown-link-check.json", to: ".markdown-link-check.json" }],
    lefthook: {
      "pre-commit": [
        {
          name: "markdown-links",
          root: "git",
          run: "npx markdown-link-check --config .markdown-link-check.json --quiet {staged_files}",
        },
      ],
    },
  },
  {
    id: "bench-guards",
    description: "Bench-specific guards (i18n / docs-consistency) vendored as scripts",
    deps: { dev: {} },
    files: [
      { from: "guards/check-i18n-guards.mjs", to: "scripts/quality/check-i18n-guards.mjs" },
      { from: "guards/check-docs-consistency.mjs", to: "scripts/quality/check-docs-consistency.mjs" },
    ],
    lefthook: {
      "pre-commit": [
        { name: "i18n-guards", run: "node scripts/quality/check-i18n-guards.mjs" },
        { name: "docs-consistency", run: "node scripts/quality/check-docs-consistency.mjs" },
      ],
    },
  },
];
