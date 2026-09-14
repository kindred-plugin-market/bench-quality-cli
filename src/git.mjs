// Git plumbing. Every call goes through execFile with shell:false and a fixed
// argv, and paths are read with NUL separation so spaces, newlines and
// non-ASCII file names survive intact.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isAbsolute, join, resolve } from "node:path";

import { CODES, CliError } from "./errors.mjs";

const execFileAsync = promisify(execFile);

export async function git(args, { cwd, allowFailure = false } = {}) {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
    return { status: 0, stdout, stderr };
  } catch (error) {
    if (allowFailure) {
      return { status: error.code ?? 1, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
    }
    throw new CliError("GIT_FAILED", `git ${args.join(" ")} failed: ${(error.stderr || error.message).trim()}`, {
      hint: "Run the command by hand in the target repository to see the full output.",
    });
  }
}

/** Repository top level of `dir`, or null when `dir` is not inside a repo. */
export async function gitTopLevel(dir) {
  const result = await git(["rev-parse", "--show-toplevel"], { cwd: dir, allowFailure: true });
  if (result.status !== 0) return null;
  const value = result.stdout.trim();
  return value ? resolve(value) : null;
}

/**
 * Shared git directory (`.git` for a normal clone, the main repository's `.git`
 * for a linked worktree). Generator state lives here so that two worktrees of
 * the same repository cannot write concurrently without seeing each other.
 */
export async function gitCommonDir(dir) {
  const result = await git(["rev-parse", "--git-common-dir"], { cwd: dir, allowFailure: true });
  if (result.status !== 0) return null;
  const value = result.stdout.trim();
  if (!value) return null;
  return isAbsolute(value) ? value : resolve(join(dir, value));
}

export async function readHooksPath(dir) {
  const result = await git(["config", "--get", "core.hooksPath"], { cwd: dir, allowFailure: true });
  if (result.status !== 0) return null;
  const value = result.stdout.trim();
  return value === "" ? null : value;
}

export async function setHooksPath(dir, value) {
  await git(["config", "core.hooksPath", value], { cwd: dir });
}

export async function unsetHooksPath(dir) {
  await git(["config", "--unset", "core.hooksPath"], { cwd: dir, allowFailure: true });
}

/** Repository-relative paths from a porcelain command, NUL separated. */
function splitNul(stdout) {
  return stdout.split("\0").filter(Boolean);
}

export async function stagedPaths(dir) {
  const result = await git(["diff", "--cached", "--name-only", "-z", "--diff-filter=ACMR"], {
    cwd: dir,
    allowFailure: true,
  });
  return result.status === 0 ? splitNul(result.stdout) : [];
}

export async function unstagedPaths(dir) {
  const result = await git(["diff", "--name-only", "-z"], { cwd: dir, allowFailure: true });
  return result.status === 0 ? splitNul(result.stdout) : [];
}

export async function isInsideRepo(dir) {
  return (await gitTopLevel(dir)) !== null;
}

export async function assertGitRepo(dir) {
  const top = await gitTopLevel(dir);
  if (!top) {
    throw new CliError(CODES.GIT_REPO_REQUIRED, `${dir} is not inside a git repository`, {
      hint: "Run `git init` first (or point --target at a checkout); write mode requires git for lock state and hooks.",
    });
  }
  return top;
}
