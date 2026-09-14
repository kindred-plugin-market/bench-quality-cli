// Vendored by bench-quality-cli (feature: commitlint).
// Edit freely — this copy lives in your repo, not in bench-quality-cli.
export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    // Conventional-commits body must be separated from the header by a blank line.
    "body-leading-blank": [2, "always"],
    // Allow any subject case (Bench does not enforce it).
    "subject-case": [0],
  },
};
