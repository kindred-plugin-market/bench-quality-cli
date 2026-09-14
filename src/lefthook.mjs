import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import yaml from "js-yaml";

// Track which (hook.kind.name) entries we own so re-runs / `update` can drop
// obsolete ones without touching consumer-authored entries.
const META_RE = /#\s*bench-quality-cli:managed-entries\s+(.*)/;

// Collect every feature's lefthook spec, keyed by hook then by entry name,
// for BOTH `commands` (run per staged file) and `scripts` (runner + `only`).
function buildManaged(chosen) {
  const hooks = {};
  for (const f of chosen) {
    for (const [hook, spec] of Object.entries(f.lefthook ?? {})) {
      const entry = (hooks[hook] ??= { commands: {}, scripts: {} });
      for (const c of spec.commands ?? []) entry.commands[c.name] = c;
      for (const s of spec.scripts ?? []) entry.scripts[s.name] = s;
    }
  }
  return hooks;
}

function toYamlCommand(c) {
  const o = {};
  if (c.root) o.root = c.root;
  if (c.stage_fixed) o.stage_fixed = true;
  o.run = c.run;
  if (c.fail_text) o.fail_text = c.fail_text;
  return o;
}

function toYamlScript(s) {
  const o = { runner: s.runner };
  if (s.stage_fixed) o.stage_fixed = true;
  if (s.only?.length) o.only = s.only;
  return o;
}

// Idempotent, NON-DESTRUCTIVE merge: we only own the named entries. Any
// consumer entry outside our managed set (e.g. prettier, rust-fmt, frontend,
// backend) is preserved. Re-running replaces our entries in place — no
// duplicate top-level `pre-commit:` keys, which a naive append would create.
export async function mergeLefthook(target, chosen) {
  const path = join(target, "lefthook.yml");
  let doc = {};
  let prevManaged = [];
  try {
    const raw = await readFile(path, "utf8");
    doc = yaml.load(raw) || {};
    const m = raw.match(META_RE);
    if (m) prevManaged = m[1].split(",").filter(Boolean);
  } catch {
    doc = {};
  }

  const managed = buildManaged(chosen);
  const managedEntries = [];

  // Drop previously-managed entries that are no longer requested.
  for (const key of prevManaged) {
    const [hook, kind, name] = key.split(".");
    if (doc[hook]?.[kind]?.[name] !== undefined) delete doc[hook][kind][name];
  }

  // Add current managed entries. When adding under `commands`, clear a same
  // name under `scripts` (and vice-versa) so a managed entry that migrated
  // between the two styles doesn't run twice.
  for (const [hook, entry] of Object.entries(managed)) {
    doc[hook] = doc[hook] || {};
    doc[hook].commands = doc[hook].commands || {};
    doc[hook].scripts = doc[hook].scripts || {};
    for (const [name, c] of Object.entries(entry.commands)) {
      delete doc[hook].scripts[name];
      doc[hook].commands[name] = toYamlCommand(c);
      managedEntries.push(`${hook}.commands.${name}`);
    }
    for (const [name, s] of Object.entries(entry.scripts)) {
      delete doc[hook].commands[name];
      doc[hook].scripts[name] = toYamlScript(s);
      managedEntries.push(`${hook}.scripts.${name}`);
    }
  }

  // Prune empty command/script blocks for tidiness.
  for (const hook of Object.keys(doc)) {
    if (doc[hook].commands && Object.keys(doc[hook].commands).length === 0)
      delete doc[hook].commands;
    if (doc[hook].scripts && Object.keys(doc[hook].scripts).length === 0)
      delete doc[hook].scripts;
  }

  const metaLine = `# bench-quality-cli:managed-entries ${managedEntries.join(",")}`;
  const header = "# Managed entries below are owned by bench-quality-cli (init/update). Do not edit by hand.\n";
  const dumped = yaml.dump(doc, { lineWidth: -1, noRefs: true, quotingType: '"' });
  await writeFile(path, `${header}${metaLine}\n${dumped}`);
  console.log("  + merged lefthook.yml (managed entries)");
}
