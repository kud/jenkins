import test from "node:test"
import assert from "node:assert/strict"
import { JenkinsClient, jobPath } from "../src/jenkins-client.js"

// Mock fetch
const calls = []
const makeResponse = (
  status: number,
  body: any,
  headers: Record<string, string> = {},
) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    statusText: "X",
    headers: { get: (k: string) => headers[k.toLowerCase()] },
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    arrayBuffer: async () =>
      new TextEncoder().encode(
        typeof body === "string" ? body : JSON.stringify(body),
      ),
    clone: () => makeResponse(status, body, headers),
  }) as unknown as Response

global.fetch = (async (url: any, opts: any) => {
  calls.push({ url, opts })
  if (url.includes("/api/json?depth=1")) {
    return makeResponse(
      200,
      {
        lastBuild: { number: 42 },
        builds: [{ number: 42 }, { number: 41 }],
        artifacts: [],
      },
      { "content-type": "application/json" },
    )
  }
  if (url.endsWith("/42/api/json")) {
    return makeResponse(
      200,
      { number: 42, building: false, result: "SUCCESS", artifacts: [] },
      { "content-type": "application/json" },
    )
  }
  if (url.endsWith("/42/consoleText")) {
    return makeResponse(200, "Console output")
  }
  if (url.includes("parameterDefinitions")) {
    return makeResponse(
      200,
      {
        property: [
          {
            parameterDefinitions: [
              {
                name: "BRANCH",
                type: "StringParameterDefinition",
                defaultParameterValue: { value: "main" },
                description: "git branch",
              },
              {
                name: "ENV",
                type: "ChoiceParameterDefinition",
                choices: ["dev", "prod"],
              },
            ],
          },
        ],
      },
      { "content-type": "application/json" },
    )
  }
  if (url.includes("changeSets")) {
    return makeResponse(
      200,
      {
        number: 42,
        actions: [
          {},
          { causes: [{ shortDescription: "Started by user Alice" }] },
        ],
        culprits: [{ fullName: "Bob" }],
        changeSets: [
          {
            items: [
              {
                commitId: "abcdef123456",
                msg: "fix bug",
                author: { fullName: "Carol" },
                date: "2026-07-03",
              },
            ],
          },
        ],
      },
      { "content-type": "application/json" },
    )
  }
  return makeResponse(404, "Not Found")
}) as any

test("getBuild resolves last build when unspecified", async () => {
  const client = new JenkinsClient("http://jenkins", "u", "t")
  const build = await client.getBuild("job-name")
  assert.equal(build.number, 42)
})

test("getConsoleText returns text", async () => {
  const client = new JenkinsClient("http://jenkins", "u", "t")
  const text = await client.getConsoleText("job-name", 42)
  assert.equal(text, "Console output")
})

test("getJobParameters flattens parameter definitions", async () => {
  const client = new JenkinsClient("http://jenkins", "u", "t")
  const defs = await client.getJobParameters("job-name")
  assert.equal(defs.length, 2)
  assert.equal(defs[0].name, "BRANCH")
  assert.equal(defs[0].defaultValue, "main")
  assert.deepEqual(defs[1].choices, ["dev", "prod"])
})

test("getBuildChanges extracts cause, culprits and commits", async () => {
  const client = new JenkinsClient("http://jenkins", "u", "t")
  const info = await client.getBuildChanges("job-name", 42)
  assert.equal(info.number, 42)
  assert.deepEqual(info.causes, ["Started by user Alice"])
  assert.deepEqual(info.culprits, ["Bob"])
  assert.equal(info.commits.length, 1)
  assert.equal(info.commits[0].author, "Carol")
  assert.equal(info.commits[0].msg, "fix bug")
})

// `tree()` is the escape hatch every other method's fixed `tree` makes
// necessary. These assert the URL it builds, because that is the whole
// behaviour — a wrong separator or an unencoded bracket is a 400 from Jenkins
// and reads to the caller like a field that does not exist.
test("tree appends an encoded tree filter", async () => {
  const client = new JenkinsClient("http://jenkins", "u", "t")
  calls.length = 0
  await client.tree("api/json", "jobs[name,_class]").catch(() => undefined)
  const url = String(calls.at(-1)?.url ?? "")
  assert.ok(url.includes("api/json?tree="), `no tree param in ${url}`)
  assert.ok(url.includes("jobs%5Bname%2C_class%5D"), `brackets unencoded in ${url}`)
})

test("tree joins with & when the path already has a query", async () => {
  const client = new JenkinsClient("http://jenkins", "u", "t")
  calls.length = 0
  await client.tree("api/json?depth=1", "jobs[name]").catch(() => undefined)
  const url = String(calls.at(-1)?.url ?? "")
  assert.ok(url.includes("depth=1&tree="), `wrong separator in ${url}`)
})

test("tree without a filter is a plain request", async () => {
  const client = new JenkinsClient("http://jenkins", "u", "t")
  calls.length = 0
  await client.tree("api/json").catch(() => undefined)
  const url = String(calls.at(-1)?.url ?? "")
  assert.ok(!url.includes("tree="), `unexpected tree param in ${url}`)
})

// `jobPath` is exported and nearly every method above routes through it, and it
// had no test at all. Both failures it can produce are a 404, and a 404 from
// Jenkins reads as "no such job" whatever actually caused it — so a wrong path
// here does not surface as a bug, it surfaces as a job somebody deleted.
test("jobPath nests folder segments rather than encoding the slashes", () => {
  assert.equal(jobPath("nightly-reindex"), "job/nightly-reindex")
  assert.equal(
    jobPath("acme-org/checkout-api/master"),
    "job/acme-org/job/checkout-api/job/master",
  )
  assert.ok(
    !jobPath("acme-org/checkout-api/master").includes("%2F"),
    "slashes must not be percent-encoded — that is a 404 on every nested job",
  )
})

test("jobPath encodes within a segment but not across them", () => {
  assert.equal(jobPath("acme org/with space"), "job/acme%20org/job/with%20space")
})

test("jobPath drops empty segments from an untidy name", () => {
  // Each of these used to yield `job//job/...`, a 404 wearing the same face as
  // a missing job. Job names come from config files and CLI arguments, so a
  // stray slash is ordinary input rather than a caller's mistake.
  assert.equal(jobPath("/leading/slash"), "job/leading/job/slash")
  assert.equal(jobPath("trailing/slash/"), "job/trailing/job/slash")
  assert.equal(jobPath("double//slash"), "job/double/job/slash")
})

// A Jenkins that allows anonymous read is a real configuration, and the client
// used to build a Basic header unconditionally — so no credentials sent
// base64("undefined:undefined"), a well-formed credential that is simply wrong.
// The assertion is that the header is ABSENT, not that it is empty: an empty
// `Authorization:` is a different request from none, and some servers reject it.
test("no credentials sends no Authorization header at all", async () => {
  const client = new JenkinsClient("http://jenkins")
  calls.length = 0
  await client.tree("api/json").catch(() => undefined)
  const headers = (calls.at(-1)?.opts?.headers ?? {}) as Record<string, string>
  assert.ok(
    !("Authorization" in headers),
    `expected no Authorization header, got ${JSON.stringify(headers)}`,
  )
  assert.equal(client.authHeader, "")
})

test("credentials still send Basic auth", async () => {
  const client = new JenkinsClient("http://jenkins", "u", "t")
  calls.length = 0
  await client.tree("api/json").catch(() => undefined)
  const headers = (calls.at(-1)?.opts?.headers ?? {}) as Record<string, string>
  assert.equal(
    headers.Authorization,
    "Basic " + Buffer.from("u:t").toString("base64"),
  )
})
