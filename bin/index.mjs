#!/usr/bin/env node
// Entry point ordering is load-bearing (see src/node-contract.mjs):
//   1) validate the runtime using a dependency-free module,
//   2) only then import the CLI (which pulls js-yaml and the rest).
// A static `import { run } from "../src/cli.mjs"` here would resolve the whole
// dependency graph first, so an unsupported runtime would fail with a SyntaxError
// or a module error instead of the NODE_VERSION_UNSUPPORTED diagnostic.
import { assertSupportedNode } from "../src/node-contract.mjs";

try {
  assertSupportedNode(process.versions.node);
} catch (error) {
  console.error(error.message);
  if (error.hint) console.error(error.hint);
  process.exit(1);
}

const { run } = await import("../src/cli.mjs");

run(process.argv.slice(2)).catch((error) => {
  console.error(error?.message ?? error);
  process.exit(1);
});
