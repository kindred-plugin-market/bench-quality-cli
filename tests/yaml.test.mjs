// js-yaml 4.3.2 → 5.4.2 compatibility suite (DEP-04 / U3).
//
// The `v4` column below is the *measured* result of js-yaml 4.3.2 on the same
// input (differential run recorded in evidence/CLI/C04). Where 5.4.2 agrees,
// that value is asserted directly; where it intentionally differs, the
// difference is asserted explicitly so a future upgrade cannot change it
// silently.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { CODES } from "../src/errors.mjs";
import { parseLefthookConfig, planLefthook, stripManagedEntries } from "../src/lefthook.mjs";
import { makeRepo, runCli } from "./helpers/cli-fixture.mjs";

const CONSTRUCTS = [
  { name: "true/false", yaml: "a: [true, false]\n", v4: { a: [true, false] }, agrees: true },
  {
    name: "yes/no/on/off stay strings (both versions)",
    yaml: "a: [yes, no, on, off]\n",
    v4: { a: ["yes", "no", "on", "off"] },
    agrees: true,
  },
  { name: "leading zeros", yaml: "a: 007\n", v4: { a: 7 }, agrees: true },
  { name: "exponent", yaml: "a: 1e3\n", v4: { a: 1000 }, agrees: true },
  { name: "hex", yaml: "a: 0x1f\n", v4: { a: 31 }, agrees: true },
  { name: "0o octal (YAML 1.2)", yaml: "a: 0o17\n", v4: { a: 15 }, agrees: true },
  { name: "legacy 017 octal", yaml: "a: 017\n", v4: { a: 17 }, agrees: true },
  { name: "quoted scalars", yaml: 'a: ["on", "2026-09-14", "007"]\n', v4: { a: ["on", "2026-09-14", "007"] }, agrees: true },
  {
    name: "merge keys with anchors are expanded",
    yaml: "base: &b { a: 1 }\nchild:\n  <<: *b\n  b: 2\n",
    v4: { base: { a: 1 }, child: { a: 1, b: 2 } },
    agrees: true,
  },
  {
    name: "lefthook-shaped document",
    yaml: 'pre-commit:\n  commands:\n    x:\n      glob:\n        - "*.md"\n        - "src/**"\n      run: node a.mjs\n',
    v4: { "pre-commit": { commands: { x: { glob: ["*.md", "src/**"], run: "node a.mjs" } } } },
    agrees: true,
  },
  // Intentional divergences: js-yaml 5 uses the YAML 1.2 core schema, so the
  // YAML 1.1-only tags are gone and a plain date stays a string.
  { name: "plain date stays a string", yaml: "a: 2026-09-14\n", v4: undefined, agrees: false, v5: { a: "2026-09-14" } },
  { name: "!!binary", yaml: 'a: !!binary "aGk="\n', v4: undefined, agrees: false, throws: /unknown scalar tag/ },
  { name: "!!set", yaml: "a: !!set { one, two }\n", v4: undefined, agrees: false, throws: /unknown mapping tag/ },
  { name: "!!timestamp", yaml: "a: !!timestamp 2026-09-14\n", v4: undefined, agrees: false, throws: /unknown scalar tag/ },
];

test("parsed values match the measured js-yaml 4.3.2 behaviour", () => {
  for (const construct of CONSTRUCTS) {
    if (construct.agrees) {
      assert.deepEqual(parseLefthookConfig(construct.yaml), construct.v4, construct.name);
    } else if (construct.v5) {
      assert.deepEqual(parseLefthookConfig(construct.yaml), construct.v5, construct.name);
    } else {
      assert.throws(
        () => parseLefthookConfig(construct.yaml),
        (error) => {
          assert.equal(error.code, CODES.INVALID_YAML, construct.name);
          assert.match(error.message, construct.throws);
          assert.match(error.hint, /Nothing was written/, "every parse failure must state that nothing was written");
          return true;
        },
        construct.name,
      );
    }
  }
});

test("dump output is byte-identical to the recorded js-yaml 4.3.2 output", async () => {
  const doc = {
    "pre-commit": {
      commands: {
        prettier: { glob: "*.{ts,tsx}", run: "pnpm exec prettier --write {staged_files}", stage_fixed: true },
        markdown: { glob: "*.md", run: "node scripts/quality/check-markdown-links.mjs {staged_files}" },
      },
      scripts: { frontend: { runner: "pnpm run lint:fe", only: ["src/**"] } },
    },
  };
  const { dump } = await import("js-yaml");
  const actual = dump(doc, { lineWidth: -1, noRefs: true, quoteStyle: "double" });
  const expected = await readFile(join(import.meta.dirname, "fixtures/lefthook-dump-v4.yaml"), "utf8");
  assert.equal(actual, expected, "dump output must not drift from 4.3.2");
});

test("managed entries are replaced while consumer entries keep their values", () => {
  const raw = `min_version: 2.0.0
pre-commit:
  commands:
    prettier:
      glob: "*.ts"
      run: pnpm exec prettier --write {staged_files}
      stage_fixed: true
    whitespace:
      stage_fixed: true
      run: node scripts/quality/fix-staged-whitespace.mjs
`;
  const plan = planLefthook({
    raw,
    features: [
      {
        id: "bench-guards",
        lefthook: {
          "pre-commit": {
            commands: [
              { name: "whitespace", run: "node scripts/quality/guard-partial-staging.mjs && node scripts/quality/fix-staged-whitespace.mjs", stage_fixed: true, priority: 3 },
            ],
          },
        },
      },
    ],
    previousEntries: ["pre-commit.commands.whitespace"],
  });
  assert.match(plan.content, /guard-partial-staging\.mjs &&/);
  assert.match(plan.content, /prettier:/);
  assert.match(plan.content, /glob: "\*\.ts"/);
  assert.equal(plan.removed.length, 0);
  assert.deepEqual(plan.entries, ["pre-commit.commands.whitespace"]);
});

test("stripManagedEntries removes only the given entries", () => {
  const raw = `pre-commit:
  commands:
    prettier:
      run: pnpm exec prettier --write {staged_files}
    whitespace:
      run: node scripts/quality/fix-staged-whitespace.mjs
`;
  const result = stripManagedEntries(raw, ["pre-commit.commands.whitespace"]);
  assert.doesNotMatch(result.content, /whitespace:/);
  assert.match(result.content, /prettier:/);
});

test("a YAML 1.1 tag in the consumer file aborts the batch untouched", async (t) => {
  const repo = await makeRepo({ files: { "package.json": "{}\n", "lefthook.yml": 'pre-commit:\n  commands:\n    x:\n      run: !!binary "aGk="\n' } });
  t.after(repo.cleanup);
  const result = runCli(["init", "--features", "commitlint"], { cwd: repo.dir });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /INVALID_YAML/);
  assert.match(result.stderr, /YAML 1\.1 tags/);
  assert.equal(await readFile(repo.file(".bench-quality.json"), "utf8").catch(() => null), null);
  assert.equal(await readFile(repo.file("lefthook.yml"), "utf8"), 'pre-commit:\n  commands:\n    x:\n      run: !!binary "aGk="\n');
});

test("rewriting keeps YAML 1.1 looking scalars verbatim", async (t) => {
  const repo = await makeRepo({
    files: {
      "package.json": "{}\n",
      "lefthook.yml": "pre-commit:\n  commands:\n    mine:\n      run: echo \"on\"\n      env:\n        MODE: on\n        WHEN: 2026-09-14\n",
    },
  });
  t.after(repo.cleanup);
  const result = runCli(["init", "--features", "commitlint"], { cwd: repo.dir });
  assert.equal(result.status, 0, result.stderr);
  const yaml = await readFile(repo.file("lefthook.yml"), "utf8");
  // js-yaml 5 quotes scalars that a YAML 1.1 parser would read differently
  // ("on" as a boolean, a bare date as a timestamp) — the values are unchanged,
  // and 4.3.2 wrote them unquoted, which is the unsafe form.
  assert.match(yaml, /MODE: "on"/);
  assert.match(yaml, /WHEN: "2026-09-14"/);
  assert.match(yaml, /mine:/);
  assert.deepEqual(parseLefthookConfig(yaml)["pre-commit"].commands.mine.env, { MODE: "on", WHEN: "2026-09-14" });
});

test("empty and non-mapping documents are rejected with stable codes", () => {
  assert.throws(() => parseLefthookConfig(""), { code: CODES.EMPTY_EXISTING_LEFTHOOK_CONFIG });
  assert.throws(() => parseLefthookConfig("# only a comment\n"), { code: CODES.EMPTY_EXISTING_LEFTHOOK_CONFIG });
  assert.throws(() => parseLefthookConfig("- a\n- b\n"), { code: CODES.LEFTHOOK_ROOT_MUST_BE_MAPPING });
});

test("round-trip is stable for repeated generations", () => {
  const raw = `colors: true
pre-commit:
  commands:
    mine:
      glob: "*.ts"
      run: echo hi
`;
  const first = planLefthook({ raw, features: [], previousEntries: [] });
  const second = planLefthook({ raw: first.content, features: [], previousEntries: [] });
  assert.equal(second.content, first.content, "a second pass must be a no-op");
  assert.equal(second.changed, false);
});
