import test from "node:test"
import assert from "node:assert/strict"
import os from "os"
import fs from "fs"
import path from "path"

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "jenkins-secret-"))
process.env.HOME = tempHome
process.env.USERPROFILE = tempHome
delete process.env.XDG_CONFIG_HOME

const { writeSecretFile, addServer, CONFIG_FILE, loadConfig } = await import(
  "../src/config.js"
)

const mode = (p: string) => fs.statSync(p).mode & 0o777
const posix = process.platform !== "win32"

test("saveConfig writes the token file 0600 in a 0700 directory under a 022 umask", { skip: !posix }, () => {
  const old = process.umask(0o022)
  try {
    addServer("one", { url: "https://one", user: "u", token: "secret" })
    assert.equal(mode(CONFIG_FILE), 0o600)
    assert.equal(mode(path.dirname(CONFIG_FILE)), 0o700)
    assert.equal(loadConfig().servers.one.token, "secret")
    // No temporary file is left behind.
    assert.deepEqual(fs.readdirSync(path.dirname(CONFIG_FILE)), ["config.json"])
  } finally {
    process.umask(old)
  }
})

test("an existing world-readable config is tightened on the next save", { skip: !posix }, () => {
  const old = process.umask(0o022)
  try {
    fs.chmodSync(CONFIG_FILE, 0o644)
    addServer("two", { url: "https://two", user: "u", token: "t2" })
    assert.equal(mode(CONFIG_FILE), 0o600)
    assert.equal(loadConfig().servers.two.token, "t2")
  } finally {
    process.umask(old)
  }
})

test("writeSecretFile creates nested directories 0700 and replaces atomically", { skip: !posix }, () => {
  const old = process.umask(0o022)
  try {
    const file = path.join(tempHome, "a", "b", "secret.json")
    writeSecretFile(file, "one")
    writeSecretFile(file, "two")
    assert.equal(fs.readFileSync(file, "utf8"), "two")
    assert.equal(mode(file), 0o600)
    assert.equal(mode(path.dirname(file)), 0o700)
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ["secret.json"])
  } finally {
    process.umask(old)
  }
})
