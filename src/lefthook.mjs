import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const START = "# >>> bench-quality-cli:managed >>>";
const END = "# <<< bench-quality-cli:managed <<<";

// Collect every feature's lefthook spec, keyed by hook name. Supports both
// `commands` (run per staged file) and `scripts` (runner + `only` path filter)
// styles — mirroring what real repos need.
function buildBlock(chosen) {
  const hooks = {};
  for (const f of chosen) {
    for (const [hook, spec] of Object.entries(f.lefthook ?? {})) {
      const entry = (hooks[hook] ??= { commands: [], scripts: [] });
      entry.commands.push(...(spec.commands ?? []));
      entry.scripts.push(...(spec.scripts ?? []));
    }
  }

  let out = "";
  for (const [hook, entry] of Object.entries(hooks)) {
    out += `${hook}:\n`;
    if (entry.commands.length) {
      out += "  commands:\n";
      for (const c of entry.commands) {
        out += `    ${c.name}:\n`;
        if (c.root) out += `      root: "${c.root}"\n`;
        if (c.stage_fixed) out += "      stage_fixed: true\n";
        out += `      run: ${yamlString(c.run)}\n`;
        if (c.fail_text) out += `      fail_text: ${yamlString(c.fail_text)}\n`;
      }
    }
    if (entry.scripts.length) {
      out += "  scripts:\n";
      for (const s of entry.scripts) {
        out += `    ${s.name}:\n`;
        out += `      runner: ${yamlString(s.runner)}\n`;
        if (s.stage_fixed) out += "      stage_fixed: true\n";
        if (s.only?.length) {
          out += "      only:\n";
          for (const p of s.only) out += `        - ${yamlString(p)}\n`;
        }
      }
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
