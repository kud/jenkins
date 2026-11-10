import test from "node:test"
import assert from "node:assert/strict"
import { JenkinsClient } from "../src/jenkins-client.js"

type Call = { url: string; opts: any }
type Route = (url: string, opts: any) => Response | undefined

const makeResponse = (
  status: number,
  body: any = "",
  headers: Record<string, string> = {},
) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    statusText: "X",
    type: "basic",
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    arrayBuffer: async () =>
      new TextEncoder().encode(
        typeof body === "string" ? body : JSON.stringify(body),
      ),
  }) as unknown as Response

const json = (body: any) =>
  makeResponse(200, body, { "content-type": "application/json" })

const CRUMB = { crumb: "abc", crumbRequestField: "Jenkins-Crumb" }

// Every write fetches a crumb first; tests list only the routes they care about.
const mockFetch = (route: Route): Call[] => {
  const calls: Call[] = []
  global.fetch = (async (url: any, opts: any) => {
    calls.push({ url, opts })
    if (url.includes("crumbIssuer/api/json")) return json(CRUMB)
    return route(url, opts) ?? makeResponse(404, "Not Found")
  }) as any
  return calls
}

const posts = (calls: Call[]) => calls.filter((c) => c.opts?.method === "POST")

const client = () => new JenkinsClient("http://jenkins", "u", "t")

// ── Job lifecycle ────────────────────────────────────────────────────────────

test("getJobConfig returns the job's config.xml", async () => {
  mockFetch((url) =>
    url.endsWith("job/folder/job/app/config.xml")
      ? makeResponse(200, "<project/>", { "content-type": "application/xml" })
      : undefined,
  )
  const r = await client().getJobConfig("folder/app")
  assert.deepEqual(r, { jobName: "folder/app", config: "<project/>" })
})

test("createJob posts XML to the parent folder's createItem with the crumb", async () => {
  const calls = mockFetch((url, opts) =>
    opts?.method === "POST" && url.includes("job/team/createItem?name=new-app")
      ? makeResponse(200)
      : undefined,
  )
  const r = await client().createJob("team/new-app", "<project/>")
  assert.deepEqual(r, { jobName: "team/new-app", created: true })
  const [post] = posts(calls)
  assert.equal(post.url, "http://jenkins/job/team/createItem?name=new-app")
  assert.equal(post.opts.body, "<project/>")
  assert.equal(post.opts.headers["Content-Type"], "application/xml")
  assert.equal(post.opts.headers["Jenkins-Crumb"], "abc")
  assert.ok(post.opts.headers.Authorization.startsWith("Basic "))
})

test("createJob at the root posts to createItem directly", async () => {
  const calls = mockFetch((url, opts) =>
    opts?.method === "POST" ? makeResponse(200) : undefined,
  )
  await client().createJob("solo", "<project/>")
  assert.equal(posts(calls)[0].url, "http://jenkins/createItem?name=solo")
})

test("createJob rejects an empty name without a request", async () => {
  const calls = mockFetch(() => undefined)
  await assert.rejects(client().createJob("/", "<x/>"), /non-empty/)
  assert.equal(calls.length, 0)
})

test("createJob surfaces a 400 from Jenkins", async () => {
  mockFetch((url, opts) =>
    opts?.method === "POST"
      ? makeResponse(400, "A job already exists")
      : undefined,
  )
  await assert.rejects(client().createJob("dup", "<x/>"), /HTTP 400/)
})

test("copyJob forces absolute source lookup with a leading slash", async () => {
  const calls = mockFetch((url, opts) =>
    opts?.method === "POST" ? makeResponse(200) : undefined,
  )
  const r = await client().copyJob("team/app", "other/app-copy")
  assert.deepEqual(r, {
    fromName: "team/app",
    newName: "other/app-copy",
    copied: true,
  })
  assert.equal(
    posts(calls)[0].url,
    "http://jenkins/job/other/createItem?name=app-copy&mode=copy&from=%2Fteam%2Fapp",
  )
})

test("updateJobConfig posts XML to config.xml", async () => {
  const calls = mockFetch((url, opts) =>
    opts?.method === "POST" && url.endsWith("job/app/config.xml")
      ? makeResponse(200)
      : undefined,
  )
  const r = await client().updateJobConfig("app", "<project/>")
  assert.deepEqual(r, { jobName: "app", updated: true })
  assert.equal(posts(calls)[0].opts.headers["Content-Type"], "application/xml")
})

test("renameJob posts to confirmRename with the encoded new name", async () => {
  const calls = mockFetch((url, opts) =>
    opts?.method === "POST" ? makeResponse(200) : undefined,
  )
  const r = await client().renameJob("app", "app v2")
  assert.deepEqual(r, { oldName: "app", newName: "app v2", renamed: true })
  assert.equal(
    posts(calls)[0].url,
    "http://jenkins/job/app/confirmRename?newName=app%20v2",
  )
})

test("deleteJob, enableJob and disableJob post to their endpoints", async () => {
  const calls = mockFetch((url, opts) =>
    opts?.method === "POST" ? makeResponse(200) : undefined,
  )
  const c = client()
  assert.deepEqual(await c.deleteJob("a/b"), { jobName: "a/b", deleted: true })
  assert.deepEqual(await c.enableJob("a/b"), { jobName: "a/b", enabled: true })
  assert.deepEqual(await c.disableJob("a/b"), {
    jobName: "a/b",
    disabled: true,
  })
  assert.deepEqual(
    posts(calls).map((p) => p.url),
    [
      "http://jenkins/job/a/job/b/doDelete",
      "http://jenkins/job/a/job/b/enable",
      "http://jenkins/job/a/job/b/disable",
    ],
  )
})

test("a missing job surfaces a 404 rather than a success", async () => {
  mockFetch(() => undefined)
  await assert.rejects(client().disableJob("ghost"), /404/)
})

// ── Builds ───────────────────────────────────────────────────────────────────

test("deleteBuild resolves a multibranch branch containing a slash", async () => {
  const calls = mockFetch((url, opts) => {
    if (url.includes("job/acme/api/json?tree=_class"))
      return json({ _class: "com.cloudbees.hudson.plugins.folder.Folder" })
    if (url.includes("job/acme/job/api-gateway/api/json?tree=_class"))
      return json({
        _class:
          "org.jenkinsci.plugins.workflow.multibranch.WorkflowMultiBranchProject",
      })
    if (
      opts?.method === "POST" &&
      url.endsWith("job/acme/job/api-gateway/job/feature%2Flogin/5/doDelete")
    )
      return makeResponse(200)
    return undefined
  })
  const r = await client().deleteBuild("acme/api-gateway/feature/login", 5)
  assert.deepEqual(r, {
    jobName: "acme/api-gateway/feature/login",
    buildNumber: 5,
    deleted: true,
  })
  const postUrls = posts(calls).map((p) => p.url)
  assert.deepEqual(postUrls, [
    "http://jenkins/job/acme/job/api-gateway/job/feature/job/login/5/doDelete",
    "http://jenkins/job/acme/job/api-gateway/job/feature%2Flogin/5/doDelete",
  ])
})

test("replayBuild returns the queue Location and does not follow redirects", async () => {
  const calls = mockFetch((url, opts) =>
    opts?.method === "POST" && url.endsWith("job/app/7/replay/rebuild")
      ? makeResponse(201, "", { location: "http://jenkins/queue/item/99/" })
      : undefined,
  )
  const r = await client().replayBuild("app", 7, "echo hi")
  assert.deepEqual(r, {
    jobName: "app",
    buildNumber: 7,
    queueUrl: "http://jenkins/queue/item/99/",
  })
  const [post] = posts(calls)
  assert.equal(post.opts.redirect, "manual")
  assert.equal(post.opts.body, "mainScript=echo+hi")
})

test("replayBuild treats a redirect as a failure", async () => {
  mockFetch((url, opts) =>
    opts?.method === "POST"
      ? makeResponse(302, "", { location: "http://jenkins/login" })
      : undefined,
  )
  await assert.rejects(client().replayBuild("app", 7), /redirects to/)
})

test("replayBuild without a Location header fails", async () => {
  mockFetch((url, opts) =>
    opts?.method === "POST" ? makeResponse(200) : undefined,
  )
  await assert.rejects(
    client().replayBuild("app", 7),
    /without a queue Location/,
  )
})

// ── Nodes ────────────────────────────────────────────────────────────────────

test("listNodes counts busy executors from the executors list", async () => {
  mockFetch((url) =>
    url.endsWith("computer/api/json?depth=1")
      ? json({
          computer: [
            {
              displayName: "built-in",
              numExecutors: 2,
              idle: false,
              executors: [{ idle: false }, { idle: true }],
            },
            {
              displayName: "agent-1",
              numExecutors: 4,
              offline: true,
              temporarilyOffline: true,
              offlineCauseReason: "maintenance",
              idle: true,
            },
          ],
        })
      : undefined,
  )
  const nodes = await client().listNodes()
  assert.equal(nodes.length, 2)
  assert.equal(nodes[0].busyExecutors, 1)
  assert.equal(nodes[1].busyExecutors, 0)
  assert.equal(nodes[1].offlineCauseReason, "maintenance")
})

test("getNode encodes the node name and maps labels", async () => {
  const calls = mockFetch((url) =>
    url.includes("computer/agent%201/api/json")
      ? json({
          displayName: "agent 1",
          numExecutors: 2,
          assignedLabels: [{ name: "linux" }, { name: "docker" }],
        })
      : undefined,
  )
  const n = await client().getNode("agent 1")
  assert.deepEqual(n.assignedLabels, ["linux", "docker"])
  assert.equal(n.numExecutors, 2)
  assert.ok(calls.some((c) => c.url.includes("computer/agent%201/")))
})

test("toggleNodeOffline posts with the offline message", async () => {
  const calls = mockFetch((url, opts) =>
    opts?.method === "POST" ? makeResponse(200) : undefined,
  )
  const r = await client().toggleNodeOffline("agent-1", "disk full")
  assert.deepEqual(r, { nodeName: "agent-1", toggledOffline: true })
  assert.equal(
    posts(calls)[0].url,
    "http://jenkins/computer/agent-1/toggleOffline?offlineMessage=disk%20full",
  )
})

// ── Views ────────────────────────────────────────────────────────────────────

test("listViews and getView map the view shape", async () => {
  mockFetch((url) => {
    if (url.includes("api/json?tree=views"))
      return json({
        views: [{ name: "All", url: "u", jobs: [{ name: "a", url: "ua" }] }],
      })
    if (url.endsWith("view/My%20View/api/json"))
      return json({
        name: "My View",
        description: "d",
        jobs: [{ name: "a", url: "ua", color: "blue" }],
      })
    return undefined
  })
  const c = client()
  assert.deepEqual(await c.listViews(), [
    { name: "All", url: "u", jobs: [{ name: "a", url: "ua" }] },
  ])
  const v = await c.getView("My View")
  assert.equal(v.description, "d")
  assert.deepEqual(v.jobs, [{ name: "a", url: "ua", color: "blue" }])
})

// ── System ───────────────────────────────────────────────────────────────────

test("getSystemInfo, getVersion and getPlugins", async () => {
  mockFetch((url, opts) => {
    if (opts?.method === "HEAD")
      return makeResponse(200, "", { "x-jenkins": "2.462.3" })
    if (url.includes("pluginManager/api/json"))
      return json({
        plugins: [{ shortName: "git", version: "5.0", active: true }],
      })
    if (url.includes("api/json?tree=nodeDescription"))
      return json({
        nodeName: "",
        numExecutors: 2,
        mode: "NORMAL",
        useCrumbs: true,
      })
    return undefined
  })
  const c = client()
  const info = await c.getSystemInfo()
  assert.equal(info.numExecutors, 2)
  assert.equal(info.useCrumbs, true)
  assert.deepEqual(await c.getVersion(), { version: "2.462.3" })
  const [plugin] = await c.getPlugins()
  assert.equal(plugin.shortName, "git")
  assert.equal(plugin.enabled, false)
})

test("quietDown, cancelQuietDown and safeRestart post once each, never retried", async () => {
  const calls = mockFetch((url, opts) =>
    opts?.method === "POST" ? makeResponse(503, "busy") : undefined,
  )
  const c = new JenkinsClient("http://jenkins", "u", "t", {
    retries: 3,
    retryDelay: 1,
  })
  await assert.rejects(c.quietDown("upgrade"), /HTTP 503/)
  assert.equal(posts(calls).length, 1)
  assert.equal(posts(calls)[0].url, "http://jenkins/quietDown?reason=upgrade")

  mockFetch((url, opts) =>
    opts?.method === "POST" ? makeResponse(200) : undefined,
  )
  assert.deepEqual(await c.quietDown(), { quietingDown: true })
  assert.deepEqual(await c.cancelQuietDown(), { quietingDown: false })
  assert.deepEqual(await c.safeRestart(), { restarting: true })
})

// ── Search ───────────────────────────────────────────────────────────────────

// Three folders deep: each level is only reachable through its full
// `job/a/job/b/job/c` path, never through its bare name at the root.
const nestedTree = (url: string) => {
  const path = url.replace(/^http:\/\/jenkins\//, "").split("api/json")[0].replace(/\/$/, "")
  const levels: Record<string, any[]> = {
    "": [{ name: "platform" }],
    "job/platform": [{ name: "services" }],
    "job/platform/job/services": [{ name: "payments" }],
    "job/platform/job/services/job/payments": [
      { name: "api-gateway", color: "blue", jobs: [] },
    ],
  }
  return path in levels ? json({ jobs: levels[path] }) : undefined
}

const folderFetches = (calls: Call[]) =>
  calls
    .map((c) => c.url.replace(/^http:\/\/jenkins\//, "").split("api/json")[0].replace(/\/$/, ""))
    .filter(Boolean)

test("searchJobs walks folders nested three levels deep by full path", async () => {
  const calls = mockFetch(nestedTree)
  const found = await client().searchJobs("api-gateway")
  assert.deepEqual(
    found.map((j) => j.fullName),
    ["platform/services/payments/api-gateway"],
  )
  assert.deepEqual(folderFetches(calls), [
    "job/platform",
    "job/platform/job/services",
    "job/platform/job/services/job/payments",
  ])
})

test("searchJobsIncremental walks folders nested three levels deep by full path", async () => {
  const calls = mockFetch(nestedTree)
  const found = await client().searchJobsIncremental("api-gateway")
  assert.deepEqual(
    found.map((j) => j.fullName),
    ["platform/services/payments/api-gateway"],
  )
  assert.deepEqual(folderFetches(calls), [
    "job/platform",
    "job/platform/job/services",
    "job/platform/job/services/job/payments",
  ])
})
