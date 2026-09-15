// C10：跨平台语义回归（换行 / 路径分隔符 / 带空格的仓库路径）。
//
// 这些用例锁定的是「同一份被验证过的代码在三个平台给出同一结论」：
//   - Windows checkout 是 CRLF（core.autocrlf 默认开启），断言必须按内容比较；
//   - `--import` 收的是 URL，不是文件路径；
//   - 仓库路径可能含空格（Windows 用户目录、CI 的 `D:\a\...`）。
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { BIN, makeRepo, runCli } from "./helpers/cli-fixture.mjs";
import { normalizeEol, toPosixPath } from "./helpers/text.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

test("normalizeEol folds CRLF and lone CR into LF", () => {
  assert.equal(normalizeEol("a\r\nb\rc\n"), "a\nb\nc\n");
  assert.equal(normalizeEol("a\nb\n"), "a\nb\n", "LF-only text must be unchanged");
});

test("toPosixPath normalizes separators without touching POSIX paths", () => {
  assert.equal(toPosixPath("C:\\repo\\bin\\index.mjs"), "C:/repo/bin/index.mjs");
  assert.equal(toPosixPath("/repo/bin/index.mjs"), "/repo/bin/index.mjs");
  assert.ok(toPosixPath(BIN).endsWith("bin/index.mjs"), `unexpected bin path: ${BIN}`);
});

test("a CRLF lefthook.yml is adopted and stays drift-free", async (t) => {
  const repo = await makeRepo({
    name: "crlf",
    files: {
      "package.json": "{}\n",
      "lefthook.yml":
        "min_version: 1.6.0\r\npre-commit:\r\n  commands:\r\n    mine:\r\n      run: echo hi\r\n",
    },
  });
  t.after(repo.cleanup);

  const init = runCli(["init", "--features", "commitlint"], { cwd: repo.dir });
  assert.equal(init.status, 0, init.stderr);

  const text = normalizeEol(await readFile(repo.file("lefthook.yml"), "utf8"));
  assert.match(text, /mine:/, "the consumer entry must survive the rewrite");
  assert.match(text, /echo hi/);
  assert.match(text, /commitlint/, "the managed entry must be written");

  // 写入的字节与 manifest 记录一致：CRLF 输入没有污染后续的 drift 诊断。
  const doctor = runCli(["doctor", "--json"], { cwd: repo.dir });
  assert.equal(doctor.status, 0, `${doctor.stdout}${doctor.stderr}`);
});

test("a repository path containing spaces works end to end", async (t) => {
  const repo = await makeRepo({ name: "spaced repo", files: { "package.json": "{}\n" } });
  t.after(repo.cleanup);
  assert.match(repo.dir, / /, "the fixture path must actually contain a space");

  const init = runCli(["init", "--features", "commitlint,markdown"], { cwd: repo.dir });
  assert.equal(init.status, 0, init.stderr);

  const doctor = runCli(["doctor", "--json"], { cwd: repo.dir });
  assert.equal(doctor.status, 0, `${doctor.stdout}${doctor.stderr}`);

  const dryRun = runCli(["update", "--dry-run"], { cwd: repo.dir });
  assert.equal(dryRun.status, 0, dryRun.stderr);
});

test(
  "--import rejects a raw Windows absolute path (negative control)",
  { skip: process.platform !== "win32" },
  () => {
    // 这正是 run 34922413857 上 node-contract 用例的失败形态：`D:\a\...` 被当成
    // scheme `d:`。用例只在 Windows 执行（其他平台原始路径本来就是合法 URL）。
    const result = spawnSync(
      process.execPath,
      ["--import", join(ROOT, "tests/fixtures/pretend-node-version.mjs"), BIN, "list"],
      { encoding: "utf8", cwd: ROOT, env: { ...process.env, BENCH_TEST_PRETEND_NODE: "20.11.1" } },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /ERR_UNSUPPORTED_ESM_URL_SCHEME/);
  },
);
