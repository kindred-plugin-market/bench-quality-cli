import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";

const run = promisify(execFile);

// Point git at .husky so the generated hooks are actually used. Best-effort:
// skipped (with a warning) if the target is not a git repo or git is absent.
export async function ensureGitHooksPath(target) {
  try {
    await run("git", ["config", "core.hooksPath", ".husky"], { cwd: target });
    console.log("  + git config core.hooksPath .husky");
  } catch {
    console.log("  ! not a git repo or git unavailable — skipping hooksPath wiring");
  }
}
