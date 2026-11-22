import test from "node:test"
import assert from "node:assert/strict"
import * as pkg from "../src/index.js"
import { sanitizeForTerminal, sanitizeLogChunk } from "../src/log-sanitizer.js"

const ESC = "\x1b"

test("sanitizeForTerminal is exported from the package entry, beside the old names", () => {
  assert.equal(typeof pkg.sanitizeForTerminal, "function")
  assert.equal(typeof pkg.sanitizeLogChunk, "function")
  assert.equal(typeof pkg.sanitizeAndAppend, "function")
})

test("OSC sequences are removed, BEL- or ST-terminated", () => {
  const clipboard = `${ESC}]52;c;ZXZpbA==\x07`
  const title = `${ESC}]0;owned${ESC}\\`
  const link = `${ESC}]8;;https://evil.example${ESC}\\click${ESC}]8;;${ESC}\\`
  assert.equal(sanitizeForTerminal(`a${clipboard}b${title}c${link}`), "abcclick")
})

test("8-bit C1 CSI, OSC and stray C1 controls are removed", () => {
  assert.equal(sanitizeForTerminal("a\x9b2Jb"), "ab")
  assert.equal(sanitizeForTerminal("a\x9d52;c;ZXZpbA==\x9cb"), "ab")
  assert.equal(sanitizeForTerminal("a\x9d0;t\x07b"), "ab")
  assert.equal(sanitizeForTerminal("a\x85\x8d\x9fb"), "ab")
  assert.equal(sanitizeLogChunk("a\x9b2Jb\x85"), "ab")
})

test("cursor movement, resets and carriage-return overprinting are removed", () => {
  assert.equal(sanitizeForTerminal(`ok${ESC}[1A${ESC}[2Kfake${ESC}c`), "okfake")
  assert.equal(sanitizeForTerminal("rm -rf /\rls"), "rm -rf /ls")
  assert.equal(sanitizeForTerminal("line1\r\nline2\tx\n"), "line1\nline2\tx\n")
})

test("colours are stripped by default and kept only on request", () => {
  const red = `${ESC}[31mred${ESC}[0m`
  assert.equal(sanitizeForTerminal(red), "red")
  assert.equal(sanitizeForTerminal(red, { preserveColors: true }), red)
  assert.equal(
    sanitizeForTerminal(`${red}${ESC}]52;c;x\x07${ESC}[2J\x9b1A`, {
      preserveColors: true,
    }),
    red,
  )
  // A forged placeholder in the input cannot resurrect anything.
  assert.equal(
    sanitizeForTerminal(`0${red}`, { preserveColors: true }),
    `0${red}`,
  )
})

test("plain text, unicode and Buffers pass through", () => {
  assert.equal(sanitizeForTerminal("café ✓ 日本"), "café ✓ 日本")
  assert.equal(sanitizeForTerminal(Buffer.from("hé\x1b[31m!")), "hé!")
})
