// Author-owned configuration: `bench-quality.config.json`.
//
// Split of responsibilities (QG-03):
//   bench-quality.config.json — written by a human: profile, the features the
//     repository wants, and opt-ins. The generator only reads it.
//   .bench-quality.json       — written by the generator: what was installed,
//     with which hashes. Never edited by hand.
//
// Command line flags win over the file; the file wins over profile defaults.
import { join } from "node:path";

import { CODES, CliError } from "./errors.mjs";
import { readJsonIfExists } from "./fsx.mjs";

export const CONFIG_FILE = "bench-quality.config.json";

const KNOWN_KEYS = new Set(["profile", "features", "acceptDrift", "excludeFeatures"]);

export async function readAuthorConfig(target) {
  const raw = await readJsonIfExists(join(target, CONFIG_FILE));
  if (raw === null) return { config: null, path: CONFIG_FILE };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new CliError(CODES.INVALID_CONFIG, `${CONFIG_FILE} must contain a JSON object`, {
      hint: "Fix the file by hand; the generator only reads this file, it never rewrites it.",
    });
  }
  for (const key of Object.keys(raw)) {
    if (!KNOWN_KEYS.has(key)) {
      throw new CliError(CODES.INVALID_CONFIG, `${CONFIG_FILE} has an unknown key: ${key}`, {
        hint: `Known keys: ${[...KNOWN_KEYS].join(", ")}.`,
      });
    }
  }
  if (raw.features !== undefined && !Array.isArray(raw.features)) {
    throw new CliError(CODES.INVALID_CONFIG, `${CONFIG_FILE} "features" must be an array of feature ids`);
  }
  if (raw.excludeFeatures !== undefined && !Array.isArray(raw.excludeFeatures)) {
    throw new CliError(CODES.INVALID_CONFIG, `${CONFIG_FILE} "excludeFeatures" must be an array of feature ids`);
  }
  if (raw.acceptDrift !== undefined && typeof raw.acceptDrift !== "boolean") {
    throw new CliError(CODES.INVALID_CONFIG, `${CONFIG_FILE} "acceptDrift" must be a boolean`);
  }
  return { config: raw, path: CONFIG_FILE };
}
