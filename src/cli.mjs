import { resolve } from "node:path";
import { features } from "./features/index.mjs";
import { vendorFile } from "./vendor.mjs";
import { updatePackageJson } from "./package-json.mjs";
import { mergeLefthook } from "./lefthook.mjs";
import { writeHooks } from "./hooks.mjs";
import { ensureGitHooksPath } from "./git.mjs";
import { promptFeatures } from "./prompt.mjs";

export async function run(argv) {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case undefined:
    case "help":
    case "-h":
    case "--help":
      return printHelp();
    case "list":
      return listFeatures();
    case "init":
      return init(rest);
    case "update":
      return init(rest, { update: true });
    default:
      console.error(`Unknown command: ${cmd}\n`);
      printHelp();
      process.exitCode = 1;
  }
}

function printHelp() {
  console.log(`bench-quality-cli — vendor opt-in Bench quality gates into any repo

Usage:
  npx bench-quality-cli init [--target <dir>] [--features a,b,c] [--yes]
  npx bench-quality-cli update      re-vendor selected features
  npx bench-quality-cli list        show available features

Generated artifacts (scripts/, lefthook.yml, .husky/, devDeps) live in the
consumer repo and are committed there. This generator repo can be deleted
without breaking already-initialized projects (delete-safe by design).

Options:
  --target <dir>    target repo root (default: cwd)
  --features <ids>  comma-separated feature ids (skip interactive picker)
  --yes             accept defaults / non-interactive (picks all features)
`);
}

function listFeatures() {
  console.log("Available features:\n");
  for (const f of features) {
    console.log(`  ${f.id.padEnd(16)} ${f.description}`);
  }
}

function parseFeaturesFromArgs(args) {
  const i = args.indexOf("--features");
  if (i === -1) return null;
  return args[i + 1].split(",").map((s) => s.trim()).filter(Boolean);
}

function getTarget(args) {
  const i = args.indexOf("--target");
  return i !== -1 ? resolve(args[i + 1]) : process.cwd();
}

function hasYes(args) {
  return args.includes("--yes") || args.includes("-y");
}

async function init(args) {
  const target = getTarget(args);
  const yes = hasYes(args);

  let selected = parseFeaturesFromArgs(args);
  if (!selected && !yes) selected = await promptFeatures();
  if (!selected) selected = features.map((f) => f.id); // --yes default = all
  if (!selected.length) {
    console.log("No features selected; nothing to do.");
    return;
  }

  const unknown = selected.filter((id) => !features.some((f) => f.id === id));
  if (unknown.length) {
    console.error(`Unknown feature(s): ${unknown.join(", ")}`);
    process.exitCode = 1;
    return;
  }

  const chosen = features.filter((f) => selected.includes(f.id));
  console.log(`\nInitializing Bench quality gates in: ${target}`);
  console.log(`Features: ${chosen.map((f) => f.id).join(", ")}\n`);

  // 1) vendor scripts/guards into the consumer repo
  for (const f of chosen) {
    for (const file of f.files ?? []) {
      await vendorFile(target, file);
    }
  }
  // 2) inject devDependencies (lefthook is always the orchestrator)
  await updatePackageJson(target, chosen);
  // 3) merge lefthook.yml (managed block)
  await mergeLefthook(target, chosen);
  // 4) write .husky hooks (iron-rule form)
  await writeHooks(target, chosen);
  // 5) wire git hooksPath
  await ensureGitHooksPath(target);

  console.log("\n✓ Done. Artifacts are vendored into this repo (delete-safe).");
  console.log("  Run `git add -A && git commit` to lock them in.");
}
