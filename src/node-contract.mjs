// Node runtime contract for bench-quality-cli.
//
// Single source of truth for the supported runtime. `package.json` engines.node
// and `.node-version` are asserted against these constants by
// tests/node-contract.test.mjs, so the three can never drift silently.
//
// Why a hand-rolled check: `engines` is not enforced for `node bin/index.mjs`
// (only for package-manager installs), and corepack/engine-strict is absent on
// plain `node` invocations. The bin entry must therefore fail closed by itself.
//
// This module MUST NOT import anything outside node: builtins — it is loaded
// before any dependency of the CLI, precisely so an unsupported runtime gets a
// stable diagnostic instead of a module-resolution/SyntaxError failure.

/** Lowest supported runtime (major, minor, patch). */
export const MIN_NODE = { major: 24, minor: 15, patch: 0 };

/** Human/`engines` representation of the minimum supported runtime. */
export const MIN_NODE_SPEC = ">=24.15.0";

/** Version used by local development and the main CI job (`.node-version`). */
export const TARGET_NODE = "26.8.2";

/** Diagnostic code emitted by the bin entry when the runtime is too old. */
export const NODE_UNSUPPORTED = "NODE_VERSION_UNSUPPORTED";

/** Parse `v26.8.2` / `26.8.2` into numeric parts; `null` when unparseable. */
export function parseNodeVersion(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(version ?? ""));
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

/** Standard semver-ish ordering for the three numeric parts. */
export function compareNodeVersion(a, b) {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

/** True when `version` satisfies the contract (>= min). */
export function isSupportedNode(version, min = MIN_NODE) {
  const parsed = parseNodeVersion(version);
  if (!parsed) {
    const error = new Error(`${NODE_UNSUPPORTED}: cannot parse runtime version ${JSON.stringify(version)}`);
    error.code = NODE_UNSUPPORTED;
    throw error;
  }
  return compareNodeVersion(parsed, min) >= 0;
}

/**
 * Throw a stable, actionable error when `version` is below `min`.
 * Returns the parsed version when supported.
 */
export function assertSupportedNode(version, min = MIN_NODE) {
  if (isSupportedNode(version, min)) return parseNodeVersion(version);
  const error = new Error(`${NODE_UNSUPPORTED}: require ${MIN_NODE_SPEC}; got ${version}`);
  error.code = NODE_UNSUPPORTED;
  error.current = version;
  error.required = MIN_NODE_SPEC;
  error.hint = `Install or switch to Node ${TARGET_NODE} (see .node-version), or use any Node ${MIN_NODE_SPEC}.`;
  throw error;
}
