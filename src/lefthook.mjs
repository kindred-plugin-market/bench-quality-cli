// lefthook.yml merge — only the entries we own are touched.
//
// Contract:
//   - a missing/absent file is created from scratch,
//   - a file that exists but is not a YAML mapping, or is empty, aborts the
//     batch (never rebuilt from an empty document),
//   - consumer entries (prettier, rust-fmt, frontend, backend, ...) are kept
//     byte-for-byte semantically identical: they are parsed and re-emitted, and
//     their values are never rewritten,
//   - our entries are replaced in place; obsolete ones recorded from the
//     previous run are dropped, including the commands/scripts migration case.
import { CODES, CliError } from "./errors.mjs";
import yaml from "js-yaml";

const META_RE = /#\s*bench-quality-cli:managed-entries\s+(.*)/;
const HEADER =
  "# Managed entries below are owned by bench-quality-cli (init/update). Do not edit by hand.\n";

export function parseManagedEntries(raw) {
  const match = raw?.match(META_RE);
  return match ? match[1].split(",").map((entry) => entry.trim()).filter(Boolean) : [];
}

export function splitEntry(key) {
  const [hook, kind, name] = key.split(".");
  if (!hook || !kind || !name) return null;
  return { hook, kind, name };
}

/** Parse an existing lefthook.yml with strict, fail-closed semantics. */
export function parseLefthookConfig(raw, pathname = "lefthook.yml") {
  if (raw.trim() === "") {
    throw new CliError(CODES.EMPTY_EXISTING_LEFTHOOK_CONFIG, `${pathname} exists but is empty`, {
      hint: "Restore the file from git (or delete it deliberately) before re-running; the generator will not rebuild it from scratch.",
    });
  }
  let doc;
  try {
    doc = yaml.load(raw);
  } catch (error) {
    throw new CliError(CODES.INVALID_YAML, `${pathname} is not valid YAML (${error.message.split("\n")[0]})`, {
      hint: "Fix the file by hand and re-run; nothing was written.",
    });
  }
  if (doc === null || doc === undefined) {
    throw new CliError(CODES.EMPTY_EXISTING_LEFTHOOK_CONFIG, `${pathname} has no YAML document`, {
      hint: "A comment-only file is treated as broken; restore or delete it before re-running.",
    });
  }
  if (typeof doc !== "object" || Array.isArray(doc)) {
    throw new CliError(CODES.LEFTHOOK_ROOT_MUST_BE_MAPPING, `${pathname} must contain a YAML mapping`, {
      hint: "lefthook.yml maps hook names to jobs; a list or scalar cannot be merged safely.",
    });
  }
  return doc;
}

/** Collect every feature's lefthook spec, keyed by hook then entry name. */
export function buildManaged(features) {
  const hooks = {};
  for (const feature of features) {
    for (const [hook, spec] of Object.entries(feature.lefthook ?? {})) {
      const entry = (hooks[hook] ??= { commands: {}, scripts: {} });
      for (const command of spec.commands ?? []) entry.commands[command.name] = command;
      for (const script of spec.scripts ?? []) entry.scripts[script.name] = script;
    }
  }
  return hooks;
}

function toYamlCommand(command) {
  const out = {};
  if (command.root) out.root = command.root;
  if (command.glob) out.glob = command.glob;
  if (command.exclude) out.exclude = command.exclude;
  if (command.priority !== undefined) out.priority = command.priority;
  out.run = command.run;
  if (command.stage_fixed) out.stage_fixed = true;
  if (command.fail_text) out.fail_text = command.fail_text;
  return out;
}

function toYamlScript(script) {
  const out = { runner: script.runner };
  if (script.stage_fixed) out.stage_fixed = true;
  if (script.only?.length) out.only = script.only;
  return out;
}

/**
 * Compute the next lefthook.yml content. Pure: takes the current text (or null)
 * plus the features we want, and returns the new text plus the entry bookkeeping
 * the manifest records.
 */
export function planLefthook({ raw, features, previousEntries = [] }) {
  const unmanaged = raw === null ? {} : parseLefthookConfig(raw);
  const doc = structuredClone(unmanaged);
  const recorded = new Set([...previousEntries, ...(raw === null ? [] : parseManagedEntries(raw))]);
  const dropped = [];

  for (const key of recorded) {
    const parts = splitEntry(key);
    if (!parts) continue;
    const bucket = doc[parts.hook]?.[parts.kind];
    if (bucket && bucket[parts.name] !== undefined) {
      delete bucket[parts.name];
      dropped.push(key);
    }
  }

  const managed = buildManaged(features);
  const entries = [];
  for (const [hook, entry] of Object.entries(managed)) {
    doc[hook] = doc[hook] ?? {};
    for (const [name, command] of Object.entries(entry.commands)) {
      // A managed entry that moved between `commands` and `scripts` must not run twice.
      if (doc[hook].scripts) delete doc[hook].scripts[name];
      doc[hook].commands = doc[hook].commands ?? {};
      doc[hook].commands[name] = toYamlCommand(command);
      entries.push(`${hook}.commands.${name}`);
    }
    for (const [name, script] of Object.entries(entry.scripts)) {
      if (doc[hook].commands) delete doc[hook].commands[name];
      doc[hook].scripts = doc[hook].scripts ?? {};
      doc[hook].scripts[name] = toYamlScript(script);
      entries.push(`${hook}.scripts.${name}`);
    }
  }

  for (const hook of Object.keys(doc)) {
    if (doc[hook]?.commands && Object.keys(doc[hook].commands).length === 0) delete doc[hook].commands;
    if (doc[hook]?.scripts && Object.keys(doc[hook].scripts).length === 0) delete doc[hook].scripts;
  }

  const content = `${HEADER}# bench-quality-cli:managed-entries ${entries.join(",")}\n${yaml.dump(doc, {
    lineWidth: -1,
    noRefs: true,
    quotingType: '"',
  })}`;

  // `removed` reports entries that are gone for good (their feature was dropped
  // or renamed), not the ones we just re-created under the same key.
  const removed = dropped.filter((key) => !entries.includes(key));

  return { content, entries, removed, changed: content !== raw };
}

/** Drop managed entries from a document (used by `remove`). */
export function stripManagedEntries(raw, entries) {
  if (raw === null) return null;
  const doc = parseLefthookConfig(raw);
  for (const key of entries) {
    const parts = splitEntry(key);
    if (!parts) continue;
    const bucket = doc[parts.hook]?.[parts.kind];
    if (bucket && bucket[parts.name] !== undefined) delete bucket[parts.name];
  }
  for (const hook of Object.keys(doc)) {
    if (doc[hook]?.commands && Object.keys(doc[hook].commands).length === 0) delete doc[hook].commands;
    if (doc[hook]?.scripts && Object.keys(doc[hook].scripts).length === 0) delete doc[hook].scripts;
  }
  const content = yaml.dump(doc, { lineWidth: -1, noRefs: true, quotingType: '"' });
  return { content, changed: content !== raw };
}
