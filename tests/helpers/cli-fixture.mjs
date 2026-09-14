// Hermetic fixture repositories for the transaction/hook suites.
//
// Every test gets a throwaway git repo under the OS temp directory: the suites
// never touch the real checkout, and `git init` keeps the lock/journal/hook
// assertions honest (the generator refuses non-root targets on purpose).
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const BIN = join(PACKAGE_ROOT, "bin/index.mjs");

export async function makeRepo({ files = {}, git = true, name = "fixture" } = {}) {
  // Canonical path: on macOS the temp dir is /var/... while realpath resolves to
  // /private/var/..., and the CLI canonicalises targets the same way.
  const dir = await realpath(await mkdtemp(join(tmpdir(), `bqcli-${name}-`)));
  for (const [relPath, content] of Object.entries(files)) {
    const absolute = join(dir, relPath);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
  }
  if (git) {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "fixture@example.invalid"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "Fixture"], { cwd: dir });
    execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: dir });
  }
  return {
    dir,
    file: (relPath) => join(dir, relPath),
    git: (...args) => {
      try {
        return execFileSync("git", args, { cwd: dir, encoding: "utf8" });
      } catch {
        return ""; // `git config --get` exits 1 for an unset key
      }
    },
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

/** Run the CLI in a fixture repo; returns { status, stdout, stderr }. */
export function runCli(args, { cwd, env = {} } = {}) {
  const result = spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", signal: result.signal };
}

export function gitStatus(dir) {
  return execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" });
}
