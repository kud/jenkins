import test from "node:test"
import assert from "node:assert/strict"
import { JenkinsClient, jobPath } from "../src/jenkins-client.js"

// ============================================================================
// MULTIBRANCH JOB NAME RESOLUTION TESTS
// ============================================================================

test("multibranch: plain nested job resolves with no extra calls", async () => {
  const calls: Array<{ url: string; opts: any }> = []
  const makeResponse = (status: number, body: any, headers: Record<string, string> = {}) => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: "X",
    headers: { get: (k: string) => headers[k.toLowerCase()] },
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    arrayBuffer: async () => new TextEncoder().encode(typeof body === "string" ? body : JSON.stringify(body)),
    clone: () => makeResponse(status, body, headers),
  }) as unknown as Response

  global.fetch = (async (url: any, opts: any) => {
    calls.push({ url, opts })
    if (url.includes("/api/json?depth=1")) {
      return makeResponse(200, { lastBuild: { number: 1 }, builds: [{ number: 1 }], artifacts: [] }, { "content-type": "application/json" })
    }
    if (url.endsWith("/1/api/json")) {
      return makeResponse(200, { number: 1, building: false, result: "SUCCESS", artifacts: [] }, { "content-type": "application/json" })
    }
    return makeResponse(404, "Not Found")
  }) as any

  const client = new JenkinsClient("http://jenkins", "u", "t")
  const build = await client.getBuild("acme-org/checkout-api/main")

  // Should have made exactly 2 calls: getJob (depth=1) and getBuild (api/json)
  // No extra _class walking calls
  const depthCalls = calls.filter(c => c.url.includes("/api/json?depth=1"))
  const apiJsonCalls = calls.filter(c => c.url.endsWith("/1/api/json"))
  assert.equal(depthCalls.length, 1, `expected 1 depth call, got ${depthCalls.length}`)
  assert.equal(apiJsonCalls.length, 1, `expected 1 api/json call, got ${apiJsonCalls.length}`)

  // Verify the URL path used plain jobPath encoding
  assert.ok(depthCalls[0].url.includes("job/acme-org/job/checkout-api/job/main/api/json?depth=1"))
  assert.ok(apiJsonCalls[0].url.includes("job/acme-org/job/checkout-api/job/main/1/api/json"))

  assert.equal(build.number, 1)
})

test("multibranch: job with slash in branch name - naive path 404, walk finds WorkflowMultiBranchProject, retries with encoded branch", async () => {
  const calls: Array<{ url: string; opts: any }> = []
  const makeResponse = (status: number, body: any, headers: Record<string, string> = {}) => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: "X",
    headers: { get: (k: string) => headers[k.toLowerCase()] },
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    arrayBuffer: async () => new TextEncoder().encode(typeof body === "string" ? body : JSON.stringify(body)),
    clone: () => makeResponse(status, body, headers),
  }) as unknown as Response

  global.fetch = (async (url: any, opts: any) => {
    calls.push({ url, opts })
    // First attempt: naive path for "acme/api-gateway/feature/login" -> job/acme/job/api-gateway/job/feature/job/login
    if (url.includes("job/acme/job/api-gateway/job/feature/job/login/api/json?depth=1")) {
      return makeResponse(404, "Not Found")
    }
    // Walk: check _class at job/acme
    if (url.includes("job/acme/api/json?tree=_class")) {
      return makeResponse(200, { _class: "com.cloudbees.hudson.plugins.folder.Folder" }, { "content-type": "application/json" })
    }
    // Walk: check _class at job/acme/job/api-gateway -> THIS is the multibranch project
    if (url.includes("job/acme/job/api-gateway/api/json?tree=_class")) {
      return makeResponse(200, { _class: "org.jenkinsci.plugins.workflow.multibranch.WorkflowMultiBranchProject" }, { "content-type": "application/json" })
    }
    // Retry with correct path: job/acme/job/api-gateway/job/feature%2Flogin/api/json?depth=1
    // (single-encoded: %2F = /)
    if (url.includes("job/acme/job/api-gateway/job/feature%2Flogin/api/json?depth=1")) {
      return makeResponse(200, { lastBuild: { number: 5 }, builds: [{ number: 5 }], artifacts: [] }, { "content-type": "application/json" })
    }
    if (url.includes("job/acme/job/api-gateway/job/feature%2Flogin/5/api/json")) {
      return makeResponse(200, { number: 5, building: false, result: "FAILURE", artifacts: [] }, { "content-type": "application/json" })
    }
    return makeResponse(404, "Not Found")
  }) as any

  const client = new JenkinsClient("http://jenkins", "u", "t")
  const build = await client.getBuild("acme/api-gateway/feature/login")

  // Verify the walk happened
  const classCalls = calls.filter(c => c.url.includes("tree=_class"))
  assert.ok(classCalls.length >= 2, `expected at least 2 _class calls, got ${classCalls.length}`)

  // Verify the retry used the encoded branch name (single-encoded: %2F = /)
  const retryDepthCall = calls.find(c => c.url.includes("feature%2Flogin") && c.url.includes("depth=1"))
  assert.ok(retryDepthCall, "expected retry with encoded branch segment")

  const retryBuildCall = calls.find(c => c.url.includes("feature%2Flogin/5/api/json"))
  assert.ok(retryBuildCall, "expected retry build call with encoded branch segment")

  assert.equal(build.number, 5)
  assert.equal(build.result, "FAILURE")
})

test("multibranch: second call uses cache (no walk again)", async () => {
  const calls: Array<{ url: string; opts: any }> = []
  const makeResponse = (status: number, body: any, headers: Record<string, string> = {}) => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: "X",
    headers: { get: (k: string) => headers[k.toLowerCase()] },
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    arrayBuffer: async () => new TextEncoder().encode(typeof body === "string" ? body : JSON.stringify(body)),
    clone: () => makeResponse(status, body, headers),
  }) as unknown as Response

  let depthCallCount = 0
  let buildCallCount = 0
  global.fetch = (async (url: any, opts: any) => {
    calls.push({ url, opts })
    // First call: naive path 404
    if (url.includes("job/org/job/repo/job/branch/job/name/api/json?depth=1")) {
      return makeResponse(404, "Not Found")
    }
    // Walk _class calls
    if (url.includes("job/org/api/json?tree=_class")) {
      return makeResponse(200, { _class: "com.cloudbees.hudson.plugins.folder.Folder" }, { "content-type": "application/json" })
    }
    if (url.includes("job/org/job/repo/api/json?tree=_class")) {
      return makeResponse(200, { _class: "org.jenkinsci.plugins.workflow.multibranch.WorkflowMultiBranchProject" }, { "content-type": "application/json" })
    }
    // Cached path depth call - return different build numbers on each call
    if (url.includes("job/org/job/repo/job/branch%2Fname/api/json?depth=1")) {
      depthCallCount++
      return makeResponse(200, { lastBuild: { number: depthCallCount }, builds: [{ number: depthCallCount }], artifacts: [] }, { "content-type": "application/json" })
    }
    // Cached path build call - return different build numbers on each call
    if (url.includes("job/org/job/repo/job/branch%2Fname/") && url.endsWith("/api/json")) {
      buildCallCount++
      return makeResponse(200, { number: buildCallCount, building: false, result: "SUCCESS", artifacts: [] }, { "content-type": "application/json" })
    }
    return makeResponse(404, "Not Found")
  }) as any

  const client = new JenkinsClient("http://jenkins", "u", "t")

  // First call - should walk and cache
  const build1 = await client.getBuild("org/repo/branch/name")
  assert.equal(build1.number, 1)

  // Count _class calls from first invocation
  const firstClassCalls = calls.filter(c => c.url.includes("tree=_class")).length
  assert.ok(firstClassCalls >= 2, "first call should walk _class")

  // Second call - should use cache, no _class calls
  calls.length = 0
  const build2 = await client.getBuild("org/repo/branch/name")
  assert.equal(build2.number, 2)

  const secondClassCalls = calls.filter(c => c.url.includes("tree=_class")).length
  assert.equal(secondClassCalls, 0, "expected no _class calls on second invocation (cache hit)")
})

test("multibranch: OrganizationFolder -> repo -> branch", async () => {
  const calls: Array<{ url: string; opts: any }> = []
  const makeResponse = (status: number, body: any, headers: Record<string, string> = {}) => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: "X",
    headers: { get: (k: string) => headers[k.toLowerCase()] },
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    arrayBuffer: async () => new TextEncoder().encode(typeof body === "string" ? body : JSON.stringify(body)),
    clone: () => makeResponse(status, body, headers),
  }) as unknown as Response

  global.fetch = (async (url: any, opts: any) => {
    calls.push({ url, opts })
    // Naive path fails
    if (url.includes("job/acme-corp/job/my-service/job/feature/login/api/json?depth=1")) {
      return makeResponse(404, "Not Found")
    }
    // Walk: org folder
    if (url.includes("job/acme-corp/api/json?tree=_class")) {
      return makeResponse(200, { _class: "jenkins.branch.OrganizationFolder" }, { "content-type": "application/json" })
    }
    // Walk: repo (multibranch project)
    if (url.includes("job/acme-corp/job/my-service/api/json?tree=_class")) {
      return makeResponse(200, { _class: "org.jenkinsci.plugins.workflow.multibranch.WorkflowMultiBranchProject" }, { "content-type": "application/json" })
    }
    // Retry with correct path: org -> repo -> branch(encoded)
    if (url.includes("job/acme-corp/job/my-service/job/feature%2Flogin/api/json?depth=1")) {
      return makeResponse(200, { lastBuild: { number: 3 }, builds: [{ number: 3 }], artifacts: [] }, { "content-type": "application/json" })
    }
    if (url.includes("job/acme-corp/job/my-service/job/feature%2Flogin/3/api/json")) {
      return makeResponse(200, { number: 3, building: false, result: "SUCCESS", artifacts: [] }, { "content-type": "application/json" })
    }
    return makeResponse(404, "Not Found")
  }) as any

  const client = new JenkinsClient("http://jenkins", "u", "t")
  const build = await client.getBuild("acme-corp/my-service/feature/login")

  // Verify org folder detected
  const orgCall = calls.find(c => c.url.includes("job/acme-corp/api/json?tree=_class"))
  assert.ok(orgCall, "expected org folder _class call")

  // Verify repo detected as multibranch
  const repoCall = calls.find(c => c.url.includes("job/acme-corp/job/my-service/api/json?tree=_class"))
  assert.ok(repoCall, "expected repo _class call")

  // Verify retry with encoded branch
  const retryCall = calls.find(c => c.url.includes("feature%2Flogin") && c.url.includes("depth=1"))
  assert.ok(retryCall, "expected retry with encoded branch")

  assert.equal(build.number, 3)
})

test("multibranch: resolution finds nothing different, surfaces original 404", async () => {
  const calls: Array<{ url: string; opts: any }> = []
  const makeResponse = (status: number, body: any, headers: Record<string, string> = {}) => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: "X",
    headers: { get: (k: string) => headers[k.toLowerCase()] },
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    arrayBuffer: async () => new TextEncoder().encode(typeof body === "string" ? body : JSON.stringify(body)),
    clone: () => makeResponse(status, body, headers),
  }) as unknown as Response

  global.fetch = (async (url: any, opts: any) => {
    calls.push({ url, opts })
    // Naive path fails
    if (url.includes("job/nonexistent/job/job/api/json?depth=1")) {
      return makeResponse(404, "Not Found")
    }
    // Walk: just a regular folder, no multibranch
    if (url.includes("job/nonexistent/api/json?tree=_class")) {
      return makeResponse(200, { _class: "com.cloudbees.hudson.plugins.folder.Folder" }, { "content-type": "application/json" })
    }
    if (url.includes("job/nonexistent/job/job/api/json?tree=_class")) {
      return makeResponse(200, { _class: "com.cloudbees.hudson.plugins.folder.Folder" }, { "content-type": "application/json" })
    }
    // Retry with same path (no multibranch found) -> 404 again
    if (url.includes("job/nonexistent/job/job/api/json?depth=1")) {
      return makeResponse(404, "Not Found")
    }
    return makeResponse(404, "Not Found")
  }) as any

  const client = new JenkinsClient("http://jenkins", "u", "t")

  try {
    await client.getBuild("nonexistent/job")
    assert.fail("expected HttpError")
  } catch (err: any) {
    assert.equal(err.status, 404)
    assert.ok(err.message.includes("404"))
  }
})

// ============================================================================
// DIAGNOSE BUILD TESTS
// ============================================================================

test("diagnoseBuild: parallel failure - two failing branches both returned", async () => {
  const calls: Array<{ url: string; opts: any }> = []
  const makeResponse = (status: number, body: any, headers: Record<string, string> = {}) => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: "X",
    headers: { get: (k: string) => headers[k.toLowerCase()] },
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    arrayBuffer: async () => new TextEncoder().encode(typeof body === "string" ? body : JSON.stringify(body)),
    clone: () => makeResponse(status, body, headers),
  }) as unknown as Response

  global.fetch = (async (url: any, opts: any) => {
    calls.push({ url, opts })
    // getJob
    if (url.includes("/api/json?depth=1")) {
      return makeResponse(200, { lastBuild: { number: 10 }, builds: [{ number: 10 }], artifacts: [] }, { "content-type": "application/json" })
    }
    // getBuild
    if (url.endsWith("/10/api/json")) {
      return makeResponse(200, { number: 10, building: false, result: "FAILURE", artifacts: [] }, { "content-type": "application/json" })
    }
    // getPipelineStages - two parallel stages both FAILED
    if (url.includes("/10/wfapi/describe")) {
      return makeResponse(200, {
        stages: [
          { id: "stage-1", name: "Build - linux", status: "FAILED", startTimeMillis: 1000, durationMillis: 5000 },
          { id: "stage-2", name: "Build - windows", status: "FAILED", startTimeMillis: 1000, durationMillis: 6000 },
          { id: "stage-3", name: "Test", status: "SUCCESS", startTimeMillis: 7000, durationMillis: 2000 },
        ]
      }, { "content-type": "application/json" })
    }
    // getStageSteps for stage-1
    if (url.includes("execution/node/stage-1/wfapi/describe")) {
      return makeResponse(200, {
        stageFlowNodes: [
          { id: "step-1-1", name: "Checkout", status: "SUCCESS" },
          { id: "step-1-2", name: "Compile", status: "FAILED" },
          { id: "step-1-3", name: "Package", status: "NOT_EXECUTED" },
        ]
      }, { "content-type": "application/json" })
    }
    // getStageSteps for stage-2
    if (url.includes("execution/node/stage-2/wfapi/describe")) {
      return makeResponse(200, {
        stageFlowNodes: [
          { id: "step-2-1", name: "Checkout", status: "SUCCESS" },
          { id: "step-2-2", name: "Compile", status: "FAILED" },
        ]
      }, { "content-type": "application/json" })
    }
    // getStepLog for step-1-2
    if (url.includes("execution/node/step-1-2/wfapi/log")) {
      return makeResponse(200, { text: "line1\nline2\nline3\nERROR: compilation failed\nline5" }, { "content-type": "application/json" })
    }
    // getStepLog for step-2-2
    if (url.includes("execution/node/step-2-2/wfapi/log")) {
      return makeResponse(200, { text: "line1\nline2\nFATAL: link error\nline4" }, { "content-type": "application/json" })
    }
    // getTestReport - 404 (no tests)
    if (url.includes("testReport/api/json")) {
      return makeResponse(404, "Not Found")
    }
    return makeResponse(404, "Not Found")
  }) as any

  const client = new JenkinsClient("http://jenkins", "u", "t")
  const result = await client.diagnoseBuild("my-job", 10)

  assert.equal(result.job, "my-job")
  assert.equal(result.build, 10)
  assert.equal(result.result, "FAILURE")
  assert.equal(result.failedStages.length, 2)
  assert.equal(result.failedStages[0].name, "Build - linux")
  assert.equal(result.failedStages[1].name, "Build - windows")
  assert.equal(result.failedStages[0].steps.length, 1)
  assert.equal(result.failedStages[0].steps[0].name, "Compile")
  assert.ok(result.failedStages[0].steps[0].logTail.includes("ERROR: compilation failed"))
  assert.equal(result.failedStages[1].steps[0].name, "Compile")
  assert.ok(result.failedStages[1].steps[0].logTail.includes("FATAL: link error"))
  assert.equal(result.tests, null)
  assert.ok(result.hints.length === 0 || result.hints.every(h => typeof h === "string"))
})

test("diagnoseBuild: stage with no FAILED step falls back to last step", async () => {
  const calls: Array<{ url: string; opts: any }> = []
  const makeResponse = (status: number, body: any, headers: Record<string, string> = {}) => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: "X",
    headers: { get: (k: string) => headers[k.toLowerCase()] },
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    arrayBuffer: async () => new TextEncoder().encode(typeof body === "string" ? body : JSON.stringify(body)),
    clone: () => makeResponse(status, body, headers),
  }) as unknown as Response

  global.fetch = (async (url: any, opts: any) => {
    calls.push({ url, opts })
    if (url.includes("/api/json?depth=1")) {
      return makeResponse(200, { lastBuild: { number: 1 }, builds: [{ number: 1 }], artifacts: [] }, { "content-type": "application/json" })
    }
    if (url.endsWith("/1/api/json")) {
      return makeResponse(200, { number: 1, building: false, result: "UNSTABLE", artifacts: [] }, { "content-type": "application/json" })
    }
    if (url.includes("/1/wfapi/describe")) {
      return makeResponse(200, {
        stages: [
          { id: "stage-1", name: "Deploy", status: "UNSTABLE", startTimeMillis: 1000, durationMillis: 5000 },
        ]
      }, { "content-type": "application/json" })
    }
    if (url.includes("execution/node/stage-1/wfapi/describe")) {
      // No step marked FAILED - all SUCCESS or UNSTABLE
      return makeResponse(200, {
        stageFlowNodes: [
          { id: "step-1", name: "Deploy to staging", status: "SUCCESS" },
          { id: "step-2", name: "Health check", status: "UNSTABLE" },
        ]
      }, { "content-type": "application/json" })
    }
    if (url.includes("execution/node/step-2/wfapi/log")) {
      return makeResponse(200, { text: "health check warning: high latency" }, { "content-type": "application/json" })
    }
    if (url.includes("testReport/api/json")) {
      return makeResponse(404, "Not Found")
    }
    return makeResponse(404, "Not Found")
  }) as any

  const client = new JenkinsClient("http://jenkins", "u", "t")
  const result = await client.diagnoseBuild("my-job", 1)

  assert.equal(result.failedStages.length, 1)
  assert.equal(result.failedStages[0].name, "Deploy")
  // Should fall back to last step (step-2) since none marked FAILED
  assert.equal(result.failedStages[0].steps.length, 1)
  assert.equal(result.failedStages[0].steps[0].name, "Health check")
  assert.equal(result.failedStages[0].steps[0].status, "UNSTABLE")
})

test("diagnoseBuild: log tail trimming by lines and bytes", async () => {
  const calls: Array<{ url: string; opts: any }> = []
  const makeResponse = (status: number, body: any, headers: Record<string, string> = {}) => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: "X",
    headers: { get: (k: string) => headers[k.toLowerCase()] },
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    arrayBuffer: async () => new TextEncoder().encode(typeof body === "string" ? body : JSON.stringify(body)),
    clone: () => makeResponse(status, body, headers),
  }) as unknown as Response

  // Test with many lines - should keep last `lines` lines
  global.fetch = (async (url: any, opts: any) => {
    calls.push({ url, opts })
    if (url.includes("/api/json?depth=1")) {
      return makeResponse(200, { lastBuild: { number: 1 }, builds: [{ number: 1 }], artifacts: [] }, { "content-type": "application/json" })
    }
    if (url.endsWith("/1/api/json")) {
      return makeResponse(200, { number: 1, building: false, result: "FAILURE", artifacts: [] }, { "content-type": "application/json" })
    }
    if (url.includes("/1/wfapi/describe")) {
      return makeResponse(200, {
        stages: [{ id: "s1", name: "Build", status: "FAILED" }]
      }, { "content-type": "application/json" })
    }
    if (url.includes("execution/node/s1/wfapi/describe")) {
      return makeResponse(200, { stageFlowNodes: [{ id: "step1", name: "Compile", status: "FAILED" }] }, { "content-type": "application/json" })
    }
    if (url.includes("execution/node/step1/wfapi/log")) {
      // 100 lines of output
      const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`)
      return makeResponse(200, { text: lines.join("\n") }, { "content-type": "application/json" })
    }
    if (url.includes("testReport/api/json")) {
      return makeResponse(404, "Not Found")
    }
    return makeResponse(404, "Not Found")
  }) as any

  const client = new JenkinsClient("http://jenkins", "u", "t")
  // Default lines=80, should keep last 80 lines (lines 21-100)
  const result = await client.diagnoseBuild("my-job", 1)
  const tail = result.failedStages[0].steps[0].logTail
  const tailLines = tail.split("\n")
  assert.equal(tailLines.length, 80, `expected 80 lines, got ${tailLines.length}`)
  assert.ok(tail.startsWith("line 21"), "expected tail to start at line 21")
  assert.ok(tail.endsWith("line 100"), "expected tail to end at line 100")

  // Test with maxBytes cap
  calls.length = 0
  global.fetch = (async (url: any, opts: any) => {
    calls.push({ url, opts })
    if (url.includes("/api/json?depth=1")) {
      return makeResponse(200, { lastBuild: { number: 2 }, builds: [{ number: 2 }], artifacts: [] }, { "content-type": "application/json" })
    }
    if (url.endsWith("/2/api/json")) {
      return makeResponse(200, { number: 2, building: false, result: "FAILURE", artifacts: [] }, { "content-type": "application/json" })
    }
    if (url.includes("/2/wfapi/describe")) {
      return makeResponse(200, { stages: [{ id: "s1", name: "Build", status: "FAILED" }] }, { "content-type": "application/json" })
    }
    if (url.includes("execution/node/s1/wfapi/describe")) {
      return makeResponse(200, { stageFlowNodes: [{ id: "step1", name: "Compile", status: "FAILED" }] }, { "content-type": "application/json" })
    }
    if (url.includes("execution/node/step1/wfapi/log")) {
      // Very long line that exceeds maxBytes
      const longLine = "x".repeat(20000)
      return makeResponse(200, { text: "short\n" + longLine }, { "content-type": "application/json" })
    }
    if (url.includes("testReport/api/json")) {
      return makeResponse(404, "Not Found")
    }
    return makeResponse(404, "Not Found")
  }) as any

  const result2 = await client.diagnoseBuild("my-job", 2, { lines: 80, maxBytes: 1000 })
  const tail2 = result2.failedStages[0].steps[0].logTail
  // Should be capped at ~1000 bytes from the END
  const encoder = new TextEncoder()
  assert.ok(encoder.encode(tail2).length <= 1000, `expected <= 1000 bytes, got ${encoder.encode(tail2).length}`)
  assert.ok(tail2.endsWith("x".repeat(1000).slice(-100)), "expected tail to keep end of long line")
})

test("diagnoseBuild: missing test report gives tests: null", async () => {
  const calls: Array<{ url: string; opts: any }> = []
  const makeResponse = (status: number, body: any, headers: Record<string, string> = {}) => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: "X",
    headers: { get: (k: string) => headers[k.toLowerCase()] },
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    arrayBuffer: async () => new TextEncoder().encode(typeof body === "string" ? body : JSON.stringify(body)),
    clone: () => makeResponse(status, body, headers),
  }) as unknown as Response

  global.fetch = (async (url: any, opts: any) => {
    calls.push({ url, opts })
    if (url.includes("/api/json?depth=1")) {
      return makeResponse(200, { lastBuild: { number: 1 }, builds: [{ number: 1 }], artifacts: [] }, { "content-type": "application/json" })
    }
    if (url.endsWith("/1/api/json")) {
      return makeResponse(200, { number: 1, building: false, result: "FAILURE", artifacts: [] }, { "content-type": "application/json" })
    }
    if (url.includes("/1/wfapi/describe")) {
      return makeResponse(200, { stages: [{ id: "s1", name: "Build", status: "FAILED" }] }, { "content-type": "application/json" })
    }
    if (url.includes("execution/node/s1/wfapi/describe")) {
      return makeResponse(200, { stageFlowNodes: [{ id: "step1", name: "Compile", status: "FAILED" }] }, { "content-type": "application/json" })
    }
    if (url.includes("execution/node/step1/wfapi/log")) {
      return makeResponse(200, { text: "error" }, { "content-type": "application/json" })
    }
    // testReport returns 404
    if (url.includes("testReport/api/json")) {
      return makeResponse(404, "Not Found")
    }
    return makeResponse(404, "Not Found")
  }) as any

  const client = new JenkinsClient("http://jenkins", "u", "t")
  const result = await client.diagnoseBuild("my-job", 1)
  assert.equal(result.tests, null)
})

test("diagnoseBuild: latest-build default when build omitted", async () => {
  const calls: Array<{ url: string; opts: any }> = []
  const makeResponse = (status: number, body: any, headers: Record<string, string> = {}) => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: "X",
    headers: { get: (k: string) => headers[k.toLowerCase()] },
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    arrayBuffer: async () => new TextEncoder().encode(typeof body === "string" ? body : JSON.stringify(body)),
    clone: () => makeResponse(status, body, headers),
  }) as unknown as Response

  global.fetch = (async (url: any, opts: any) => {
    calls.push({ url, opts })
    // getJob called first to resolve lastBuild
    if (url.includes("/api/json?depth=1")) {
      return makeResponse(200, { lastBuild: { number: 99 }, builds: [{ number: 99 }], artifacts: [] }, { "content-type": "application/json" })
    }
    if (url.endsWith("/99/api/json")) {
      return makeResponse(200, { number: 99, building: false, result: "SUCCESS", artifacts: [] }, { "content-type": "application/json" })
    }
    if (url.includes("/99/wfapi/describe")) {
      return makeResponse(200, { stages: [] }, { "content-type": "application/json" })
    }
    if (url.includes("testReport/api/json")) {
      return makeResponse(404, "Not Found")
    }
    return makeResponse(404, "Not Found")
  }) as any

  const client = new JenkinsClient("http://jenkins", "u", "t")
  const result = await client.diagnoseBuild("my-job") // no build number
  assert.equal(result.build, 99)
})

test("diagnoseBuild: non-Pipeline job (wfapi/describe 404) returns failedStages: [] with hint", async () => {
  const calls: Array<{ url: string; opts: any }> = []
  const makeResponse = (status: number, body: any, headers: Record<string, string> = {}) => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: "X",
    headers: { get: (k: string) => headers[k.toLowerCase()] },
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    arrayBuffer: async () => new TextEncoder().encode(typeof body === "string" ? body : JSON.stringify(body)),
    clone: () => makeResponse(status, body, headers),
  }) as unknown as Response

  global.fetch = (async (url: any, opts: any) => {
    calls.push({ url, opts })
    if (url.includes("/api/json?depth=1")) {
      return makeResponse(200, { lastBuild: { number: 1 }, builds: [{ number: 1 }], artifacts: [] }, { "content-type": "application/json" })
    }
    if (url.endsWith("/1/api/json")) {
      return makeResponse(200, { number: 1, building: false, result: "FAILURE", artifacts: [] }, { "content-type": "application/json" })
    }
    // wfapi/describe returns 404 for non-pipeline jobs
    if (url.includes("/1/wfapi/describe")) {
      return makeResponse(404, "Not Found")
    }
    if (url.includes("testReport/api/json")) {
      return makeResponse(404, "Not Found")
    }
    return makeResponse(404, "Not Found")
  }) as any

  const client = new JenkinsClient("http://jenkins", "u", "t")
  const result = await client.diagnoseBuild("freestyle-job", 1)

  assert.equal(result.failedStages.length, 0)
  assert.ok(result.hints.includes("no pipeline stages (not a Pipeline job)"))
  assert.equal(result.result, "FAILURE")
  assert.equal(result.tests, null)
})

test("diagnoseBuild: test report with failed cases", async () => {
  const calls: Array<{ url: string; opts: any }> = []
  const makeResponse = (status: number, body: any, headers: Record<string, string> = {}) => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: "X",
    headers: { get: (k: string) => headers[k.toLowerCase()] },
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    arrayBuffer: async () => new TextEncoder().encode(typeof body === "string" ? body : JSON.stringify(body)),
    clone: () => makeResponse(status, body, headers),
  }) as unknown as Response

  global.fetch = (async (url: any, opts: any) => {
    calls.push({ url, opts })
    if (url.includes("/api/json?depth=1")) {
      return makeResponse(200, { lastBuild: { number: 1 }, builds: [{ number: 1 }], artifacts: [] }, { "content-type": "application/json" })
    }
    if (url.endsWith("/1/api/json")) {
      return makeResponse(200, { number: 1, building: false, result: "UNSTABLE", artifacts: [] }, { "content-type": "application/json" })
    }
    if (url.includes("/1/wfapi/describe")) {
      return makeResponse(200, { stages: [{ id: "s1", name: "Test", status: "UNSTABLE" }] }, { "content-type": "application/json" })
    }
    if (url.includes("execution/node/s1/wfapi/describe")) {
      return makeResponse(200, { stageFlowNodes: [{ id: "step1", name: "Run tests", status: "UNSTABLE" }] }, { "content-type": "application/json" })
    }
    if (url.includes("execution/node/step1/wfapi/log")) {
      return makeResponse(200, { text: "tests executed" }, { "content-type": "application/json" })
    }
    // testReport with failed cases
    if (url.includes("testReport/api/json")) {
      return makeResponse(200, {
        failCount: 3,
        passCount: 10,
        skipCount: 1,
        suites: [
          {
            cases: [
              { className: "com.acme.FooTest", name: "testBar", status: "FAILED", errorDetails: "expected <5> but was <3>", errorStackTrace: "java.lang.AssertionError\nat FooTest.testBar(FooTest.java:42)\n..." },
              { className: "com.acme.FooTest", name: "testBaz", status: "PASSED" },
              { className: "com.acme.IntegrationTest", name: "testFlow", status: "REGRESSION", errorDetails: "timeout", errorStackTrace: "java.util.TimeoutException\nat IntegrationTest.testFlow(IntegrationTest.java:10)\n..." },
            ]
          }
        ]
      }, { "content-type": "application/json" })
    }
    return makeResponse(404, "Not Found")
  }) as any

  const client = new JenkinsClient("http://jenkins", "u", "t")
  const result = await client.diagnoseBuild("my-job", 1, { maxTests: 10 })

  assert.ok(result.tests !== null)
  assert.equal(result.tests!.failed, 3)
  assert.equal(result.tests!.total, 14) // failCount + passCount + skipCount
  assert.equal(result.tests!.first.length, 2) // FAILED + REGRESSION
  assert.equal(result.tests!.first[0].name, "com.acme.FooTest.testBar")
  assert.equal(result.tests!.first[0].error, "expected <5> but was <3>")
  assert.ok(result.tests!.first[0].stackHead!.includes("AssertionError"))
  assert.equal(result.tests!.first[1].name, "com.acme.IntegrationTest.testFlow")
  assert.equal(result.tests!.first[1].error, "timeout")
})