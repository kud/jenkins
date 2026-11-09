import type { ErrorBlock } from "./types.js"
import { sanitizeLogChunk } from "./log-sanitizer.js"

// SGR colour codes whose ESC byte was lost on the way (Jenkins strips it from
// some step logs), leaving "[31m[1mError[22m:" in the text.
const BARE_SGR = /\[(?:\d{1,3}(?:;\d{1,3})*)?m/g

// A step log as plain text: ANSI escapes, bare colour codes and stray control
// characters removed, so patterns match what a person would read.
export const cleanStepLog = (log: string): string =>
  sanitizeLogChunk(log).replace(BARE_SGR, "")

// Conservative on purpose: a bare `FAILED` is printed in harmless places by
// Jenkins and npm, so it only counts at the start of a line.
export const DEFAULT_ERROR_PATTERNS: RegExp[] = [
  /\bError:/,
  /\bfailed:/i,
  /✘/,
  /^\s*FAILED\b/,
  // Runner summaries, for steps whose details live elsewhere (a remote runner)
  /\bSome tests failed\b/,
  /^\s*[1-9]\d* failed\b/,
  /^\s*FAIL\b/,
  /\bFailed Tests [1-9]/,
]

const REPORT_LINK = /\breport(?:\s+link)?\s*:\s*(https?:\/\/\S+)/i

// URLs a step prints as its report ("Report Link: https://…", "report: https://…"),
// in order, without duplicates. A remote runner's step log often holds no
// error at all, only this pointer to where the failure is.
export const findReportLinks = (log: string): string[] => {
  const links: string[] = []
  for (const line of log.split("\n")) {
    const url = REPORT_LINK.exec(line)?.[1]
    if (url && !links.includes(url)) links.push(url)
  }
  return links
}

export interface FindErrorLinesOptions {
  patterns?: RegExp[]
  context?: number
  maxBlocks?: number
  maxBytes?: number
}

// The lines of one step log that look like the failure, each with a little
// context. Overlapping blocks merge; the last `maxBlocks` are kept, then the
// earliest are dropped until the total fits `maxBytes`. `line` is 1-based.
export const findErrorLines = (
  log: string,
  {
    patterns = DEFAULT_ERROR_PATTERNS,
    context = 2,
    maxBlocks = 5,
    maxBytes = 4096,
  }: FindErrorLinesOptions = {},
): ErrorBlock[] => {
  const lines = log.split("\n")
  const ranges: Array<[number, number]> = []

  lines.forEach((text, i) => {
    if (!patterns.some((p) => ((p.lastIndex = 0), p.test(text)))) return
    const start = Math.max(0, i - context)
    const end = Math.min(lines.length - 1, i + context)
    const last = ranges[ranges.length - 1]
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end)
    else ranges.push([start, end])
  })

  const blocks = ranges.slice(-maxBlocks).map(([start, end]) => ({
    line: start + 1,
    text: lines.slice(start, end + 1),
  }))

  const size = (b: ErrorBlock) =>
    new TextEncoder().encode(b.text.join("\n")).length
  let total = blocks.reduce((n, b) => n + size(b), 0)
  while (blocks.length > 1 && total > maxBytes) total -= size(blocks.shift()!)

  return blocks
}
