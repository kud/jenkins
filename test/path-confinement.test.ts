import test from "node:test"
import assert from "node:assert/strict"
import {
  JenkinsClient,
  JenkinsInputError,
  jobPath,
} from "../src/jenkins-client.js"

// Every request the client sends, by URL and method. Each answers 200 JSON so a
// call that is not refused completes and shows the URL it would have hit.
const calls: { url: string; method: string }[] = []
const reply = (body: any = {}) =>
  ({
    ok: true,
    status: 200,
    statusText: "OK",
    type: "basic",
    headers: {
      get: (k: string) =>
        k.toLowerCase() === "content-type" ? "application/json" : null,
    },
    json: async () => body,
    text: async () => JSON.stringify(body),
    arrayBuffer: async () => new TextEncoder().encode("bytes").buffer,
  }) as unknown as Response

globalThis.fetch = (async (url: any, init: any = {}) => {
  // The URL as fetch would resolve it, so collapsed dot segments show up here.
  calls.push({ url: new URL(String(url)).href, method: init.method || "GET" })
  if (String(url).includes("crumbIssuer")) return reply({})
  return reply({ number: 7, lastBuild: { number: 7 } })
}) as any

const client = () => new JenkinsClient("https://ci.example.com", "u", "t")

const refuses = async (fn: () => Promise<unknown>) => {
  calls.length = 0
  await assert.rejects(fn, (e: unknown) => e instanceof JenkinsInputError)
  assert.deepEqual(calls, [], "no request may leave for a refused input")
}

const urlOf = async (fn: () => Promise<unknown>) => {
  calls.length = 0
  await fn()
  return calls.filter((c) => !c.url.includes("crumbIssuer")).map((c) => c.url)
}

const HOSTILE_BUILDS: unknown[] = [
  "7/../../victim/doDelete?x=",
  "../7",
  "7?delay=0",
  "7#",
  "7/stop",
  "lastBuild/../../x",
  "0",
  0,
  -1,
  1.5,
  "1e3",
  " 7",
  "",
  null,
  {},
]

test("build numbers that are not a positive integer or permalink are refused", async () => {
  const c = client()
  for (const b of HOSTILE_BUILDS) {
    await refuses(() => c.stopBuild("job", b as any))
    await refuses(() => c.deleteBuild("job", b as any))
    await refuses(() => c.getTestReport("job", b as any))
    await refuses(() => c.getStageSteps("job", b as any, "5"))
    await refuses(() => c.getStepLog("job", b as any, "5"))
    await refuses(() => c.downloadArtifact("job", b as any, "a.txt"))
    await refuses(() => c.replayBuild("job", b as any))
    // null means "omitted" there, which is lastBuild by design.
    if (b !== null) await refuses(() => c.getPipelineStages("job", b as any))
  }
  // A truthy hostile value is used as given rather than resolved to lastBuild.
  for (const b of ["7/../../victim/doDelete?x=", "7?x", "../7"]) {
    await refuses(() => c.getBuild("job", b as any))
    await refuses(() => c.getConsoleText("job", b as any))
    await refuses(() => c.getBuildChanges("job", b as any))
    await refuses(() => c.streamConsole("job", b as any, () => {}))
  }
})

test("build numbers and permalinks still reach the right URL", async () => {
  const c = client()
  assert.deepEqual(await urlOf(() => c.stopBuild("job", 7)), [
    "https://ci.example.com/job/job/7/stop",
  ])
  assert.deepEqual(await urlOf(() => c.stopBuild("job", "42" as any)), [
    "https://ci.example.com/job/job/42/stop",
  ])
  for (const p of [
    "lastBuild",
    "lastSuccessfulBuild",
    "lastFailedBuild",
    "lastStableBuild",
    "lastUnstableBuild",
    "lastCompletedBuild",
  ]) {
    assert.deepEqual(await urlOf(() => c.getPipelineStages("folder/job", p)), [
      `https://ci.example.com/job/folder/job/job/${p}/wfapi/describe`,
    ])
  }
  assert.deepEqual(await urlOf(() => c.getPipelineStages("job")), [
    "https://ci.example.com/job/job/lastBuild/wfapi/describe",
  ])
  assert.deepEqual(await urlOf(() => c.getStepLog("job", 7, "12")), [
    "https://ci.example.com/job/job/7/execution/node/12/wfapi/log",
  ])
})

test("queue ids must be integers", async () => {
  const c = client()
  for (const id of ["1&x=y", "../quietDown", "1/../../x", "", "-1", 1.5, null])
    await refuses(() => c.cancelQueueItem(id as any))
  assert.deepEqual(await urlOf(() => c.cancelQueueItem(123)), [
    "https://ci.example.com/queue/cancelItem?id=123",
  ])
  assert.deepEqual(await urlOf(() => c.cancelQueueItem("123")), [
    "https://ci.example.com/queue/cancelItem?id=123",
  ])
})

test("flow node ids cannot leave their segment", async () => {
  const c = client()
  for (const id of ["../../../quietDown", "5/x", "5?x", ""])
    await refuses(() => c.getStageSteps("job", 7, id))
})

test("artifact paths with traversal or empty segments are refused", async () => {
  const c = client()
  for (const p of [
    "../../../config.xml",
    "a/../../b",
    "./a",
    "a/.",
    "/etc/passwd",
    "a//b",
    "a/",
    "",
    "..",
  ])
    await refuses(() => c.downloadArtifact("job", 7, p))
})

test("artifact paths keep subdirectories and encode each segment", async () => {
  const c = client()
  assert.deepEqual(
    await urlOf(() =>
      c.downloadArtifact("folder/job", 7, "build/out dir/report #1?.html"),
    ),
    [
      "https://ci.example.com/job/folder/job/job/7/artifact/build/out%20dir/report%20%231%3F.html",
    ],
  )
  assert.deepEqual(
    await urlOf(() => c.downloadArtifact("job", 7, "target/app.jar")),
    ["https://ci.example.com/job/job/7/artifact/target/app.jar"],
  )
})

test("job names with dot segments are refused, nested folders still work", async () => {
  const c = client()
  for (const j of ["..", "a/../../quietDown", "./a", "folder/."]) {
    assert.throws(() => jobPath(j), JenkinsInputError)
    await refuses(() => c.triggerBuild(j))
    await refuses(() => c.deleteJob(j))
    await refuses(() => c.getJob(j))
  }
  await refuses(() => c.createJob("../evil", "<project/>"))
  await refuses(() => c.copyJob("../src", "dst"))
  assert.equal(jobPath("org/repo/feature x"), "job/org/job/repo/job/feature%20x")
  assert.equal(jobPath("a?b#c"), "job/a%3Fb%23c")
  assert.equal(jobPath("v1.2..3"), "job/v1.2..3")
})

test("node and view names cannot traverse", async () => {
  const c = client()
  for (const n of ["..", ".", ""]) {
    await refuses(() => c.getNode(n))
    await refuses(() => c.toggleNodeOffline(n))
    await refuses(() => c.getView(n))
  }
  assert.deepEqual(await urlOf(() => c.getNode("agent 1/x")), [
    "https://ci.example.com/computer/agent%201%2Fx/api/json?depth=1",
  ])
})
