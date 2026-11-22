import test from "node:test"
import assert from "node:assert/strict"
import { JenkinsClient } from "../src/jenkins-client.js"

// Its own file, hence its own process: the warning is once per process.
test("credentials over plain http warn once; https, loopback and anonymous do not", () => {
  const seen: string[] = []
  const original = process.emitWarning
  process.emitWarning = ((msg: any, opts: any) => {
    if (opts?.code === "JENKINS_INSECURE_TRANSPORT") seen.push(String(msg))
  }) as any
  try {
    new JenkinsClient("https://ci.example.com", "u", "t")
    new JenkinsClient("http://localhost:8080", "u", "t")
    new JenkinsClient("http://127.0.0.1:8080", "u", "t")
    new JenkinsClient("http://ci.example.com")
    assert.equal(seen.length, 0)
    new JenkinsClient("http://ci.example.com", "u", "t")
    new JenkinsClient("http://other.example.com", "", "", { auth: { bearer: "b" } })
    assert.equal(seen.length, 1)
    assert.match(seen[0], /ci\.example\.com/)
    assert.doesNotMatch(seen[0], /\bt\b.*\bu\b|Basic/)
  } finally {
    process.emitWarning = original
  }
})
