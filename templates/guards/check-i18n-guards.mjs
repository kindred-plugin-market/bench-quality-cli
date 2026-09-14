#!/usr/bin/env node
// Vendored by bench-quality-cli (feature: bench-guards).
// Placeholder i18n key guard. Replace with your real checks.
import { readFileSync } from "node:fs";

const FILE = "src/locales/en.json";
try {
  JSON.parse(readFileSync(FILE, "utf8"));
  console.log("i18n-guards: OK");
} catch (e) {
  console.error(`i18n-guards: FAILED to parse ${FILE}: ${e.message}`);
  process.exit(1);
}
