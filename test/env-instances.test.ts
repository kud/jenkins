import test from "node:test"
import assert from "node:assert/strict"
import os from "os"
import fs from "fs"
import path from "path"

// Isolated HOME so a real ~/.config/jenkins-cli/config.json cannot contribute
// stored servers to these assertions.
const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "jenkins-env-inst-"))
process.env.HOME = tempHome
process.env.USERPROFILE = tempHome

const JENKINS_KEYS = [
  "JENKINS_URL",
  "JENKINS_USER",
  "JENKINS_API_TOKEN",
  "JENKINS_INSTANCES",
  "JENKINS_SERVER",
  "JENKINS_TIMEOUT",
  "JENKINS_RETRIES",
]

const clearEnv = () => {
  for (const key of JENKINS_KEYS) delete process.env[key]
}

clearEnv()

const { envInstances, resolveConfig, listInstances } =
  await import("../src/config.js")

test("no JENKINS_URL yields no instances", () => {
  clearEnv()
  assert.deepEqual(envInstances(), [])
})

test("a single URL yields one instance named from its hostname", () => {
  clearEnv()
  process.env.JENKINS_URL = "https://ci.example.com"
  process.env.JENKINS_USER = "alice"
  process.env.JENKINS_API_TOKEN = "t1"

  const instances = envInstances()
  assert.equal(instances.length, 1)
  assert.equal(instances[0].name, "ci")
  assert.equal(instances[0].url, "https://ci.example.com")
  assert.equal(instances[0].token, "t1")
})

test("a trailing slash is trimmed from the URL", () => {
  clearEnv()
  process.env.JENKINS_URL = "https://ci.example.com/"
  assert.equal(envInstances()[0].url, "https://ci.example.com")
})

test("JENKINS_INSTANCES names the comma-separated URLs positionally", () => {
  clearEnv()
  process.env.JENKINS_INSTANCES = "pipeline,scheduler"
  process.env.JENKINS_URL =
    "https://pipeline.example.com,https://scheduler.example.com"
  process.env.JENKINS_USER = "alice,bob"
  process.env.JENKINS_API_TOKEN = "t1,t2"

  const instances = envInstances()
  assert.deepEqual(
    instances.map((i) => i.name),
    ["pipeline", "scheduler"],
  )
  assert.equal(instances[1].url, "https://scheduler.example.com")
  assert.equal(instances[1].user, "bob")
  assert.equal(instances[1].token, "t2")
})

test("a pipe separates as well as a comma", () => {
  clearEnv()
  process.env.JENKINS_INSTANCES = "a|b"
  process.env.JENKINS_URL = "https://a.example.com|https://b.example.com"
  assert.equal(envInstances().length, 2)
})

test("a single user and token apply to every instance", () => {
  clearEnv()
  process.env.JENKINS_INSTANCES = "pipeline,scheduler"
  process.env.JENKINS_URL =
    "https://pipeline.example.com,https://scheduler.example.com"
  process.env.JENKINS_USER = "alice"
  process.env.JENKINS_API_TOKEN = "shared"

  const instances = envInstances()
  assert.equal(instances[1].user, "alice")
  assert.equal(instances[1].token, "shared")
})

test("a name/URL count mismatch throws rather than pairing them off", () => {
  clearEnv()
  process.env.JENKINS_INSTANCES = "pipeline,scheduler,extra"
  process.env.JENKINS_URL =
    "https://pipeline.example.com,https://scheduler.example.com"

  assert.throws(() => envInstances(), /counts must match/)
})

test("resolveConfig uses the first instance by default", () => {
  clearEnv()
  process.env.JENKINS_INSTANCES = "pipeline,scheduler"
  process.env.JENKINS_URL =
    "https://pipeline.example.com,https://scheduler.example.com"
  process.env.JENKINS_API_TOKEN = "t1,t2"

  const cfg = resolveConfig()
  assert.equal(cfg.url, "https://pipeline.example.com")
  assert.equal(cfg.token, "t1")
})

test("JENKINS_SERVER selects a named instance", () => {
  clearEnv()
  process.env.JENKINS_INSTANCES = "pipeline,scheduler"
  process.env.JENKINS_URL =
    "https://pipeline.example.com,https://scheduler.example.com"
  process.env.JENKINS_API_TOKEN = "t1,t2"
  process.env.JENKINS_SERVER = "scheduler"

  const cfg = resolveConfig()
  assert.equal(cfg.url, "https://scheduler.example.com")
  assert.equal(cfg.token, "t2")
})

test("an explicit server override beats JENKINS_SERVER", () => {
  clearEnv()
  process.env.JENKINS_INSTANCES = "pipeline,scheduler"
  process.env.JENKINS_URL =
    "https://pipeline.example.com,https://scheduler.example.com"
  process.env.JENKINS_SERVER = "scheduler"

  assert.equal(
    resolveConfig({ server: "pipeline" }).url,
    "https://pipeline.example.com",
  )
})

// The rename is the breaking change in 2.0.0 — pin it, so a well-meaning
// compatibility shim cannot quietly reintroduce the old name later.
test("JENKINS_TOKEN is no longer read", () => {
  clearEnv()
  process.env.JENKINS_URL = "https://ci.example.com"
  process.env.JENKINS_TOKEN = "legacy"

  assert.equal(envInstances()[0].token, undefined)
  delete process.env.JENKINS_TOKEN
})

test("listInstances reports the environment's instances", () => {
  clearEnv()
  process.env.JENKINS_INSTANCES = "pipeline,scheduler"
  process.env.JENKINS_URL =
    "https://pipeline.example.com,https://scheduler.example.com"

  assert.deepEqual(
    listInstances().map((i) => i.name),
    ["pipeline", "scheduler"],
  )
})
