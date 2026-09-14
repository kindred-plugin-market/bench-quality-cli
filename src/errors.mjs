// Stable, greppable error codes. Every failure path of the CLI raises a
// CliError (or is wrapped into one) so that hooks/CI logs carry a machine
// readable reason instead of a bare stack trace. `hint` holds one actionable
// sentence and never an absolute path of the machine that produced it.
export class CliError extends Error {
  constructor(code, message, { hint, details } = {}) {
    super(`${code}: ${message}`);
    this.name = "CliError";
    this.code = code;
    this.hint = hint;
    this.details = details;
  }
}

export const CODES = {
  // arguments / usage
  UNKNOWN_COMMAND: "UNKNOWN_COMMAND",
  UNKNOWN_FLAG: "UNKNOWN_FLAG",
  MISSING_FLAG_VALUE: "MISSING_FLAG_VALUE",
  UNKNOWN_FEATURE: "UNKNOWN_FEATURE",
  UNKNOWN_PROFILE: "UNKNOWN_PROFILE",
  INVALID_TARGET: "INVALID_TARGET",
  // target / filesystem safety
  GIT_REPO_REQUIRED: "GIT_REPO_REQUIRED",
  PATH_OUTSIDE_TARGET: "PATH_OUTSIDE_TARGET",
  PATH_IS_SYMLINK: "PATH_IS_SYMLINK",
  TARGET_NOT_DIRECTORY: "TARGET_NOT_DIRECTORY",
  // configuration state
  INVALID_JSON: "INVALID_JSON",
  INVALID_YAML: "INVALID_YAML",
  INVALID_CONFIG: "INVALID_CONFIG",
  INVALID_MANIFEST: "INVALID_MANIFEST",
  EMPTY_EXISTING_LEFTHOOK_CONFIG: "EMPTY_EXISTING_LEFTHOOK_CONFIG",
  LEFTHOOK_ROOT_MUST_BE_MAPPING: "LEFTHOOK_ROOT_MUST_BE_MAPPING",
  // conflicts
  FILE_DRIFT: "FILE_DRIFT",
  // concurrency / recovery
  REPO_LOCKED: "REPO_LOCKED",
  STALE_LOCK: "STALE_LOCK",
  RECOVERY_REQUIRED: "RECOVERY_REQUIRED",
  RECOVERY_CONFLICT: "RECOVERY_CONFLICT",
  NOTHING_TO_RECOVER: "NOTHING_TO_RECOVER",
};
