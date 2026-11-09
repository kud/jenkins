import test from "node:test"
import assert from "node:assert/strict"
import { JenkinsClient } from "../src/jenkins-client.js"

const json = (status: number, body: any): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    statusText: "X",
    headers: { get: (k: string) => (k.toLowerCase() === "content-type" ? "application/json" : null) },
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  }) as unknown as Response

test("getStepLog decodes HTML entities", async () => {
  global.fetch = (async () =>
    json(200, { text: '<b>a &lt;b&gt; &quot;c&quot; &#39;d&#39; &amp;amp;</b>' })) as any
  const client = new JenkinsClient("http://jenkins", "u", "t")
  const log = await client.getStepLog("app", 1, "7")
  assert.equal(log, `a <b> "c" 'd' &amp;`)
})

test("a cached multibranch path skips the naive request", async () => {
  const calls: string[] = []
  global.fetch = (async (url: string) => {
    calls.push(url)
    if (url.includes("job/acme/job/api-gateway/job/feature/job/login/")) return json(404, "Not Found")
    if (url.endsWith("job/acme/api/json?tree=_class")) return json(200, { _class: "x.Folder" })
    if (url.endsWith("job/acme/job/api-gateway/api/json?tree=_class"))
      return json(200, { _class: "x.WorkflowMultiBranchProject" })
    if (url.includes("feature%2Flogin/3/api/json")) return json(200, { number: 3, result: "SUCCESS" })
    return json(404, "Not Found")
  }) as any
  const client = new JenkinsClient("http://jenkins", "u", "t")
  await client.getBuild("acme/api-gateway/feature/login", 3)
  calls.length = 0
  await client.getBuild("acme/api-gateway/feature/login", 3)
  assert.equal(calls.length, 1)
  assert.ok(calls[0].includes("feature%2Flogin/3/api/json"))
})

test("diagnoseBuild uses the build's own url and fetches it once", async () => {
  const calls: string[] = []
  global.fetch = (async (url: string) => {
    calls.push(url)
    if (url.endsWith("/job/app/lastBuild/api/json"))
      return json(200, { number: 9, result: "SUCCESS", url: "http://jenkins/job/app/9/" })
    return json(404, "Not Found")
  }) as any
  const client = new JenkinsClient("http://jenkins", "u", "t")
  const d = await client.diagnoseBuild("app", "lastBuild")
  assert.equal(d.build, 9)
  assert.equal(d.url, "http://jenkins/job/app/9/")
  assert.equal(calls.filter((u) => /\/(lastBuild|9)\/api\/json$/.test(u)).length, 1)
})

test("diagnoseBuild total stays a number when report counts are partial", async () => {
  global.fetch = (async (url: string) => {
    if (url.endsWith("/job/app/4/api/json")) return json(200, { number: 4, result: "UNSTABLE" })
    if (url.includes("testReport"))
      return json(200, { failCount: 0, passCount: 2, suites: [{ cases: [{ status: "PASSED" }, { status: "PASSED" }] }] })
    return json(404, "Not Found")
  }) as any
  const client = new JenkinsClient("http://jenkins", "u", "t")
  const d = await client.diagnoseBuild("app", 4)
  assert.equal(d.tests?.total, 2)
})
