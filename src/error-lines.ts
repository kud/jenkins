import type { ErrorBlock } from "./types.js"

// Conservative on purpose: a bare `FAILED` is printed in harmless places by
// Jenkins and npm, so it only counts at the start of a line.
export const DEFAULT_ERROR_PATTERNS: RegExp[] = [
  /\bError:/,
  /\bfailed:/i,
  /✘/,
  /^\s*FAILED\b/,
]

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
