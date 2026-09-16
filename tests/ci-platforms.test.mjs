import test from "node:test"
import assert from "node:assert/strict"

import { findForbiddenCiPlatforms } from "../templates/guards/check-ci-platforms.mjs"

test("allows the scoped Ubuntu browser job used by critical E2E", () => {
  const content = `jobs:
  # Chromium dependencies are isolated to this job.
  e2e-critical:
    runs-on: ubuntu-latest
    name: Linux Chromium E2E
    run: pnpm exec playwright test --project=chromium
  frontend:
    runs-on: macos-latest
`
  assert.deepEqual(findForbiddenCiPlatforms("ci.yml", content), [])
})

test("still rejects Linux outside the scoped browser job", () => {
  const content = `jobs:
  build:
    runs-on: ubuntu-latest
`
  const violations = findForbiddenCiPlatforms("ci.yml", content)
  assert.equal(violations.length, 1)
  assert.equal(violations[0].label, "Ubuntu runner")
})
