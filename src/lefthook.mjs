import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const START = "# >>> bench-quality-cli:managed >>>";
const END = "# <<< bench-quality-cli:managed <<<";

// Collect every feature's lefthook commands, keyed by hook name.
function buildBlock(chosen) {
  const hooks = {};
  for (const f of chosen) {
    for (const [hook, cmds] of Object.entries(f.lefthook ?? {})) {
      hooks[hook] = (hooks[hook] ?? []).concat(cmds);
    }
  }
  let out = "";
  for (const [hook, cmds] of Object.entries(hooks)) {
    out += `${hook}:\n  commands:\n`;
    for (const c of cmds) {
      out += `    ${c.name}:\n`;
      if (c.root) out += `      root: "${c.root}"\n`;
      out += `      run: ${yamlString(c.run)}\n`;
    }
  }
  return out;
}

function yamlString(s) {
  return /[{"}:#]/.test(s) ? JSON.stringify(s) : s;
}

// Idempotent, non-destructive merge: we only own the managed block, so any
// consumer edits outside the markers survive re-runs (init / update).
export async function mergeLefthook(target, chosen) {
  const path = join(target, "lefthook.yml");
  const managed = `${START}\n${buildBlock(chosen)}${END}\n`;
  let content = "";
  try {
    content = await readFile(path, "utf8");
  } catch {
    content = "# Managed block below is owned by bench-quality-cli.\n";
  }
  const re = new RegExp(`${escapeRe(START)}[\\s\\S]*?${escapeRe(END)}\\n?`);
  content = re.test(content) ? content.replace(re, managed) : content + `\n${managed}`;
  await writeFile(path, content);
  console.log("  + merged lefthook.yml (managed block)");
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
