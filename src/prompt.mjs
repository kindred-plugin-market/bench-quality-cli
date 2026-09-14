import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { features } from "./features/index.mjs";

// Minimal interactive feature picker (used when --features is omitted).
export async function promptFeatures() {
  const rl = createInterface({ input: stdin, output: stdout });
  console.log("Available features:");
  for (const f of features) console.log(`  ${f.id} — ${f.description}`);
  const ans = await rl.question("\nSelect features (comma-separated ids, or 'all'): ");
  rl.close();
  const v = ans.trim();
  if (!v || v.toLowerCase() === "all") return features.map((f) => f.id);
  return v.split(",").map((s) => s.trim()).filter(Boolean);
}
