import test from "node:test"
import assert from "node:assert/strict"
import { cleanStepLog, findErrorLines, findReportLinks } from "../src/error-lines.js"
import { JenkinsClient } from "../src/jenkins-client.js"

// The shape that hid the real failure: the error sits mid-log, and the tail is
// nothing but artefact uploads.
const uploads = Array.from(
  { length: 120 },
  (_, i) => `Uploaded report/data/${i}.png to s3://acme-ci-artifacts/run-42/${i}.png`,
)
const e2eLog = [
  "Running 14 tests using 2 workers",
  "  ✓ cart adds an item (1.2s)",
  "  ✘ checkout applies the coupon (4.1s)",
  "    applyCoupon failed: 400",
  '    {"message":"Missing cart state: coupon_window"}',
  "  ✓ cart removes an item (0.9s)",
  "  1 failed",
  ...uploads,
].join("\n")

test("findErrorLines finds the failure above the upload noise", () => {
  const blocks = findErrorLines(e2eLog)
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].line, 1)
  assert.ok(blocks[0].text.some((l) => l.includes("Missing cart state")))
  assert.ok(blocks[0].text.some((l) => l.includes("applyCoupon failed:")))
})

test("findErrorLines merges overlapping blocks and keeps the last five", () => {
  const log = Array.from({ length: 200 }, (_, i) =>
    i % 20 === 0 ? `Error: boom ${i}` : `line ${i}`,
  ).join("\n")
  const blocks = findErrorLines(log)
  assert.equal(blocks.length, 5)
  assert.equal(blocks[4].text[2], "Error: boom 180")
  assert.equal(blocks[4].line, 179)

  const close = findErrorLines("a\nError: one\nb\nError: two\nc")
  assert.equal(close.length, 1)
  assert.deepEqual(close[0].text, ["a", "Error: one", "b", "Error: two", "c"])
})

test("findErrorLines ignores a bare FAILED mid-line and returns [] on a clean log", () => {
  assert.deepEqual(findErrorLines("npm notice: 0 FAILED checks\nall good"), [])
  assert.equal(findErrorLines("x\n  FAILED tests/cart.spec.ts\ny").length, 1)
})

test("findErrorLines caps the total size by dropping the earliest blocks", () => {
  const big = "x".repeat(1500)
  const log = [1, 2, 3, 4].map((n) => `Error: ${n} ${big}`).join("\n\n\n\n\n")
  const blocks = findErrorLines(log, { maxBytes: 4096 })
  assert.ok(blocks.length < 4)
  assert.ok(blocks.at(-1)!.text.some((l) => l.startsWith("Error: 4")))
})

test("errorPatterns replaces the defaults", () => {
  assert.deepEqual(findErrorLines("Error: x", { patterns: [/BOOM/] }), [])
  assert.equal(findErrorLines("BOOM", { patterns: [/BOOM/] }).length, 1)
})

test("diagnoseBuild returns errorLines and the log's line count", async () => {
  const json = (status: number, body: any) =>
    ({
      ok: status < 300,
      status,
      statusText: "X",
      headers: { get: (k: string) => (k === "content-type" ? "application/json" : null) },
      json: async () => body,
      text: async () => JSON.stringify(body),
    }) as unknown as Response
  global.fetch = (async (url: string) => {
    if (url.endsWith("/job/app/7/api/json")) return json(200, { number: 7, result: "FAILURE" })
    if (url.endsWith("/7/wfapi/describe")) return json(200, { stages: [{ id: "3", name: "E2E", status: "FAILED" }] })
    if (url.endsWith("/execution/node/3/wfapi/describe")) return json(200, { stageFlowNodes: [{ id: "4", name: "Shell Script", status: "FAILED" }] })
    if (url.endsWith("/execution/node/4/wfapi/log")) return json(200, { text: e2eLog })
    return json(404, {})
  }) as any
  const d = await new JenkinsClient("http://jenkins", "u", "t").diagnoseBuild("app", 7)
  const step = d.failedStages[0].steps[0]
  assert.equal(step.logLineCount, 127)
  assert.ok(step.errorLines![0].text.some((l) => l.includes("Missing cart state")))
  assert.ok(step.logTail.includes("s3://"))
  assert.equal(d.tests, null)
})

test("a remote runner's summary counts as an error line", () => {
  const log = [
    "[10:02] Report Link: https://reports.example.com/run/42/index.html#failed",
    "[10:02] Framework execution completed in 1428 seconds",
    "[10:02] Some tests failed.",
  ].join("\n")
  const blocks = findErrorLines(log)
  assert.equal(blocks.length, 1)
  assert.ok(blocks[0].text.at(-1)!.includes("Some tests failed."))
  assert.equal(findErrorLines("  3 failed\n  0 failed\n").length, 1)
  assert.deepEqual(findErrorLines("  0 failed\n  12 passed"), [])
})

test("findReportLinks pulls report URLs out of a step log", () => {
  const log = [
    "Report Link: https://reports.example.com/run/42/index.html#failed",
    "html report: http://ci.example.com/artifact/report/index.html",
    "Report Link: https://reports.example.com/run/42/index.html#failed",
    "no link here, just the word report",
  ].join("\n")
  assert.deepEqual(findReportLinks(log), [
    "https://reports.example.com/run/42/index.html#failed",
    "http://ci.example.com/artifact/report/index.html",
  ])
  assert.deepEqual(findReportLinks("nothing"), [])
})

test("cleanStepLog removes ANSI escapes and bare colour codes", () => {
  const esc = "\x1b[31m\x1b[1mError\x1b[22m: lockfile entry no longer resolves\x1b[39m"
  const bare = "[31m[1mError[22m: lockfile entry no longer resolves[39m"
  assert.equal(cleanStepLog(esc), "Error: lockfile entry no longer resolves")
  assert.equal(cleanStepLog(bare), "Error: lockfile entry no longer resolves")
  assert.equal(cleanStepLog("array[0] stays"), "array[0] stays")
})

test("coloured test-runner failures are found once cleaned", () => {
  const log = [
    "[41m[1m FAIL [22m[49m src/cart.test.ts > applies the coupon",
    "[31m[1mError[22m: expected 3 to be 4[39m",
    "",
    "[31m⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯[39m",
    " Test Files  1 failed | 4 passed (5)",
  ].join("\n")
  const blocks = findErrorLines(cleanStepLog(log))
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].text[0], " FAIL  src/cart.test.ts > applies the coupon")
  assert.ok(blocks[0].text.includes("Error: expected 3 to be 4"))
  assert.equal(findErrorLines("Failed Tests 0").length, 0)
})
