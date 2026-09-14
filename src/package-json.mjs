import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

// lefthook is the orchestrator for every feature, so it is always injected.
const BASE_DEPS = { lefthook: "^2" };

export async function updatePackageJson(target, chosen) {
  const pkgPath = join(target, "package.json");
  let pkg = {};
  try {
    pkg = JSON.parse(await readFile(pkgPath, "utf8"));
  } catch {
    pkg = { name: "consumer", version: "0.0.0", private: true };
  }
  pkg.devDependencies = pkg.devDependencies ?? {};
  const merged = { ...BASE_DEPS };
  for (const f of chosen) Object.assign(merged, f.deps?.dev ?? {});

  for (const [k, v] of Object.entries(merged)) {
    if (pkg.devDependencies[k] && pkg.devDependencies[k] !== v) {
      console.log(`  ~ ${k} already ${pkg.devDependencies[k]} (requested ${v}) — kept existing`);
    } else {
      pkg.devDependencies[k] = v;
    }
  }
  await writeFile(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  console.log("  + updated package.json devDependencies");
}
