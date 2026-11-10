import test from "node:test"
import assert from "node:assert/strict"
import { JenkinsClient } from "../src/jenkins-client.js"

type Call = { url: string; method: string; headers: Record<string, string> }

const response = (
  status: number,
  body: unknown = "",
  headers: Record<string, string> = {},
  setCookies: string[] = [],
) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    statusText: "X",
    type: "basic",
    headers: {
      get: (k: string) => headers[k.toLowerCase()] ?? null,
      getSetCookie: () => setCookies,
    },
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  }) as unknown as Response

const json = (body: unknown) =>
  response(200, body, { "content-type": "application/json" })

// A Jenkins whose crumbs are bound to a session: each crumbIssuer call opens a
// new session, and a write is accepted only with the current session's crumb
// and cookie. `expire()` ends the session, as Jenkins does after inactivity.
const sessionJenkins = () => {
  const calls: Call[] = []
  let session = 0
  let live = true
  global.fetch = (async (url: string, opts: any = {}) => {
    const headers = (opts.headers ?? {}) as Record<string, string>
    calls.push({ url, method: opts.method ?? "GET", headers })
    if (url.endsWith("crumbIssuer/api/json")) {
      session++
      live = true
      return response(
        200,
        { crumb: `crumb-${session}`, crumbRequestField: "Jenkins-Crumb" },
        { "content-type": "application/json" },
        [`JSESSIONID.abc=s${session}; Path=/; HttpOnly`],
      )
    }
    if (opts.method === "POST") {
      const ok =
        live &&
        headers["Jenkins-Crumb"] === `crumb-${session}` &&
        headers.Cookie === `JSESSIONID.abc=s${session}`
      return ok
        ? response(201, "", { location: "http://jenkins/queue/item/7/" })
        : response(403, "No valid crumb was included in the request")
    }
    return response(404, "Not Found")
  }) as any
  return {
    calls,
    expire: () => {
      live = false
    },
    crumbCalls: () =>
      calls.filter((c) => c.url.endsWith("crumbIssuer/api/json")).length,
  }
}

// ============================================================================
// AUTH
// ============================================================================

test("auth.bearer sends a Bearer header on reads and writes", async () => {
  const jenkins = sessionJenkins()
  const client = new JenkinsClient("http://jenkins", "", "", {
    auth: { bearer: "tok" },
  })
  await client.tree("api/json").catch(() => undefined)
  await client.triggerBuild("app")
  assert.equal(client.authHeader, "Bearer tok")
  for (const call of jenkins.calls)
    assert.equal(call.headers.Authorization, "Bearer tok", call.url)
})

test("auth.bearer wins over a user and token given alongside it", () => {
  const client = new JenkinsClient("http://jenkins", "u", "t", {
    auth: { bearer: "tok" },
  })
  assert.equal(client.authHeader, "Bearer tok")
})

test("an empty bearer falls back to the user and token", () => {
  const client = new JenkinsClient("http://jenkins", "u", "t", {
    auth: { bearer: "" },
  })
  assert.equal(
    client.authHeader,
    "Basic " + Buffer.from("u:t").toString("base64"),
  )
})

// ============================================================================
// CRUMB SESSION
// ============================================================================

test("a write carries the crumb and the session cookie it was issued with", async () => {
  const jenkins = sessionJenkins()
  const client = new JenkinsClient("http://jenkins", "u", "t")
  const res = await client.triggerBuild("app")
  assert.equal(res.location, "http://jenkins/queue/item/7/")
  const post = jenkins.calls.find((c) => c.method === "POST")!
  assert.equal(post.headers["Jenkins-Crumb"], "crumb-1")
  assert.equal(post.headers.Cookie, "JSESSIONID.abc=s1")
})

test("the crumb is reused across writes in the same session", async () => {
  const jenkins = sessionJenkins()
  const client = new JenkinsClient("http://jenkins", "u", "t")
  await client.triggerBuild("app")
  await client.stopBuild("app", 3)
  await client.cancelQueueItem(7).catch(() => undefined)
  assert.equal(jenkins.crumbCalls(), 1)
})

test("an expired session is re-issued once and the write retried", async () => {
  const jenkins = sessionJenkins()
  const client = new JenkinsClient("http://jenkins", "u", "t")
  await client.triggerBuild("app")
  jenkins.expire()
  const res = await client.triggerBuild("app")
  assert.equal(res.location, "http://jenkins/queue/item/7/")
  assert.equal(jenkins.crumbCalls(), 2)
  const last = jenkins.calls.filter((c) => c.method === "POST").at(-1)!
  assert.equal(last.headers["Jenkins-Crumb"], "crumb-2")
  assert.equal(last.headers.Cookie, "JSESSIONID.abc=s2")
})

test("the re-issue applies to _post writes too (createJob, deleteBuild, …)", async () => {
  const jenkins = sessionJenkins()
  const client = new JenkinsClient("http://jenkins", "u", "t")
  await client.createJob("new-job", "<project/>")
  jenkins.expire()
  await client.deleteBuild("app", 3)
  assert.equal(jenkins.crumbCalls(), 2)
})

test("a 403 that persists after one re-issue surfaces, without a loop", async () => {
  const calls: string[] = []
  global.fetch = (async (url: string, opts: any = {}) => {
    calls.push(`${opts.method ?? "GET"} ${url}`)
    if (url.endsWith("crumbIssuer/api/json"))
      return json({ crumb: "c", crumbRequestField: "Jenkins-Crumb" })
    return response(403, "Forbidden")
  }) as any
  const client = new JenkinsClient("http://jenkins", "u", "t")
  await assert.rejects(client.triggerBuild("app"), /Trigger failed: 403/)
  assert.equal(calls.filter((c) => c.startsWith("POST")).length, 2)
})

test("a 403 on a write sent without a crumb is not retried", async () => {
  const calls: string[] = []
  global.fetch = (async (url: string, opts: any = {}) => {
    calls.push(`${opts.method ?? "GET"} ${url}`)
    if (url.endsWith("crumbIssuer/api/json")) return response(404, "Not Found")
    return response(403, "Forbidden")
  }) as any
  const client = new JenkinsClient("http://jenkins", "u", "t")
  await assert.rejects(client.stopBuild("app", 1), /Stop failed: 403/)
  assert.equal(calls.filter((c) => c.startsWith("POST")).length, 1)
})

// ============================================================================
// resolveJobPath
// ============================================================================

const classes: Record<string, string> = {
  "job/acme": "jenkins.branch.OrganizationFolder",
  "job/acme/job/api":
    "org.jenkinsci.plugins.workflow.multibranch.WorkflowMultiBranchProject",
  "job/repo":
    "org.jenkinsci.plugins.workflow.multibranch.WorkflowMultiBranchProject",
  "job/Team": "com.cloudbees.hudson.plugins.folder.Folder",
  "job/Team/job/svc": "org.jenkinsci.plugins.workflow.job.WorkflowJob",
}

const classJenkins = () => {
  const calls: string[] = []
  global.fetch = (async (url: string) => {
    calls.push(url)
    const path = url
      .replace("http://jenkins/", "")
      .replace("/api/json?tree=_class", "")
    return classes[path]
      ? json({ _class: classes[path] })
      : response(404, "Not Found")
  }) as any
  return calls
}

test("resolveJobPath keeps a multibranch branch's slash inside one segment", async () => {
  classJenkins()
  const client = new JenkinsClient("http://jenkins")
  assert.equal(
    await client.resolveJobPath("repo/feature/x"),
    "job/repo/job/feature%2Fx",
  )
})

test("resolveJobPath handles an organisation folder", async () => {
  classJenkins()
  const client = new JenkinsClient("http://jenkins")
  assert.equal(
    await client.resolveJobPath("acme/api/release/1.2"),
    "job/acme/job/api/job/release%2F1.2",
  )
})

test("resolveJobPath leaves an ordinary folder path as jobPath gives it", async () => {
  classJenkins()
  const client = new JenkinsClient("http://jenkins")
  assert.equal(await client.resolveJobPath("Team/svc"), "job/Team/job/svc")
})

test("resolveJobPath caches a resolved path for the life of the client", async () => {
  const calls = classJenkins()
  const client = new JenkinsClient("http://jenkins")
  await client.resolveJobPath("repo/feature/x")
  const before = calls.length
  assert.equal(
    await client.resolveJobPath("repo/feature/x"),
    "job/repo/job/feature%2Fx",
  )
  assert.equal(calls.length, before)
})
