// C11：托管文件所有权 + doctor/update 漂移语义一致性。
//
// 旧行为：doctor 拿整文件哈希比 manifest（package.json / pnpm-workspace.yaml 的合法
// 消费者改动也报 drift），update 对同一批文件却按「语义合并」判 unchanged。运维人员
// 无法区分「真实冲突」与「安全的消费者扩展」，而消费者格式器重排生成文件时两者都会
// 报成 conflict —— 因为所有权从未声明过。
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { describe, it } from "node:test";

import { PRETTIER_IGNORE_FILE, planPrettierIgnore } from "../src/prettier-ignore.mjs";
import { makeRepo, runCli } from "./helpers/cli-fixture.mjs";

const MANAGED_SCRIPT = "scripts/quality/git-changes.mjs";

const doctorReport = (result) => JSON.parse(result.stdout);

describe("planPrettierIgnore（格式器所有权声明）", () => {
  const managedPaths = ["scripts/quality/git-changes.mjs", "commitlint.config.js", "lefthook.yml", "package.json"];

  it("只声明真正会被格式器重排的托管路径", () => {
    const plan = planPrettierIgnore({ raw: null, managedPaths });
    assert.equal(plan.existed, false);
    assert.equal(plan.changed, true);
    assert.deepEqual(plan.managedLines, ["scripts/quality/", "commitlint.config.js", "lefthook.yml"]);
    assert.doesNotMatch(plan.content, /package\.json/, "package.json 是语义合并的，不豁免格式化");
    assert.match(plan.content, /scripts\/quality\//);
  });

  it("消费者自己的行与 CRLF 行尾原样保留，托管块可幂等重写", () => {
    const raw = "dist/\r\nnode_modules/\r\n# 团队约定\r\n";
    const first = planPrettierIgnore({ raw, managedPaths });
    assert.ok(first.content.startsWith("dist/\r\nnode_modules/\r\n# 团队约定\r\n"), "消费者行不得被改动");
    const second = planPrettierIgnore({ raw: first.content, managedPaths, previousLines: first.managedLines });
    assert.equal(second.changed, false, "同样输入必须幂等");
  });

  it("托管路径减少时只删自己那几行", () => {
    const first = planPrettierIgnore({ raw: "dist/\n", managedPaths });
    const second = planPrettierIgnore({
      raw: first.content,
      managedPaths: ["scripts/quality/git-changes.mjs"],
      previousLines: first.managedLines,
    });
    assert.deepEqual(second.managedLines, ["scripts/quality/"]);
    assert.match(second.content, /^dist\/\n/);
    assert.doesNotMatch(second.content, /commitlint\.config\.js/);
  });
});

describe("doctor 与 update 共用同一套漂移语义", () => {
  it("init 会声明格式器所有权，并把托管块写进 .prettierignore", async (t) => {
    const repo = await makeRepo({ files: { "package.json": "{}\n" } });
    t.after(repo.cleanup);
    const init = runCli(["init", "--features", "commitlint"], { cwd: repo.dir });
    assert.equal(init.status, 0, init.stderr);

    const ignore = await readFile(join(repo.dir, PRETTIER_IGNORE_FILE), "utf8");
    assert.match(ignore, /bench-quality-cli managed/);
    assert.match(ignore, /scripts\/quality\//);
    const manifest = JSON.parse(await readFile(join(repo.dir, ".bench-quality.json"), "utf8"));
    assert.ok(manifest.prettierIgnore.managedLines.includes("lefthook.yml"));
  });

  it("消费者在合并文件里的合法改动不再被 doctor 报成 drift", async (t) => {
    const repo = await makeRepo({ files: { "package.json": "{}\n" } });
    t.after(repo.cleanup);
    assert.equal(runCli(["init", "--features", "commitlint"], { cwd: repo.dir }).status, 0);

    // 消费者扩展：脚本、workspace 键（两组都是「安全的扩展」而不是冲突）
    const pkg = JSON.parse(await readFile(join(repo.dir, "package.json"), "utf8"));
    pkg.scripts["my-tool"] = "node scripts/my-tool.mjs";
    await writeFile(join(repo.dir, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
    await writeFile(join(repo.dir, PRETTIER_IGNORE_FILE), `dist/\n${await readFile(join(repo.dir, PRETTIER_IGNORE_FILE), "utf8")}`);

    const doctor = runCli(["doctor", "--json"], { cwd: repo.dir });
    const report = doctorReport(doctor);
    assert.deepEqual(report.managed.localEdits, [], "合并文件的消费者改动不是 drift");
    assert.deepEqual(
      report.findings.filter((finding) => finding.code === "FILE_DRIFT"),
      [],
    );

    const dryRun = runCli(["update", "--dry-run"], { cwd: repo.dir });
    assert.equal(dryRun.status, 0, `${dryRun.stdout}${dryRun.stderr}`);
    assert.match(dryRun.stdout, /0 conflict/);
  });

  it("逐字节托管文件被本地改动时，doctor 与 update 同时报同一批文件", async (t) => {
    const repo = await makeRepo({ files: { "package.json": "{}\n" } });
    t.after(repo.cleanup);
    assert.equal(runCli(["init", "--features", "commitlint"], { cwd: repo.dir }).status, 0);
    await writeFile(join(repo.dir, MANAGED_SCRIPT), "// consumer edited this generated file\n");

    const report = doctorReport(runCli(["doctor", "--json"], { cwd: repo.dir }));
    const drift = report.findings.find((finding) => finding.code === "FILE_DRIFT");
    assert.deepEqual(drift.paths, [MANAGED_SCRIPT], "doctor 必须点名被改的生成文件");

    const dryRun = runCli(["update", "--dry-run"], { cwd: repo.dir });
    assert.equal(dryRun.status, 1, "update 必须以冲突失败（不允许静默覆盖）");
    assert.match(dryRun.stdout, new RegExp(`conflict\\s+${MANAGED_SCRIPT.replace(/[/.]/g, "\\$&")}`));
  });

  it("托管文件被删除时两边都报 missing（可安全重建）", async (t) => {
    const repo = await makeRepo({ files: { "package.json": "{}\n" } });
    t.after(repo.cleanup);
    assert.equal(runCli(["init", "--features", "commitlint"], { cwd: repo.dir }).status, 0);
    const { rm } = await import("node:fs/promises");
    await rm(join(repo.dir, MANAGED_SCRIPT));

    const report = doctorReport(runCli(["doctor", "--json"], { cwd: repo.dir }));
    const missing = report.findings.find((finding) => finding.code === "FILE_MISSING");
    assert.deepEqual(missing.paths, [MANAGED_SCRIPT]);
    assert.equal(existsSync(join(repo.dir, MANAGED_SCRIPT)), false, "doctor 绝不写文件");

    const dryRun = runCli(["update", "--dry-run"], { cwd: repo.dir });
    assert.equal(dryRun.status, 0, "缺失的托管文件是可安全重建的状态，不是冲突");
    assert.match(dryRun.stdout, new RegExp(`create\\s+${MANAGED_SCRIPT.replace(/[/.]/g, "\\$&")}`));
  });
});
