// Guards for every caller-supplied piece that ends up in a Jenkins URL path.
//
// ⚠ AN AUTHENTICATED CLIENT MUST NOT BE STEERABLE TO ANOTHER PATH. Every
// request carries the configured credentials, and every POST a crumb and
// session cookie, so a build number or artifact path that smuggles `/`, `..`
// or a query string turns "stop build 7 of job A" into a crumbed POST to any
// endpoint the account can reach. URL parsing collapses `..` segments before
// the request leaves, so encoding alone is not enough: `.` and `..` are refused
// outright, and every other segment is percent-encoded so it stays one segment.

/** Raised when an argument would not form a single, well-defined Jenkins path. */
export class JenkinsInputError extends Error {
  code = "JENKINS_INVALID_INPUT"
  constructor(message: string) {
    super(message)
    this.name = "JenkinsInputError"
  }
}

/** Jenkins' build permalinks, accepted wherever a build number is. */
export const BUILD_PERMALINKS = [
  "lastBuild",
  "lastSuccessfulBuild",
  "lastFailedBuild",
  "lastStableBuild",
  "lastUnstableBuild",
  "lastCompletedBuild",
] as const

const show = (value: unknown): string => {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

const isDotSegment = (s: string) => s === "." || s === ".."

/**
 * The non-empty segments of a slash-separated Jenkins full name, refusing `.`
 * and `..`. Empty segments are dropped (a stray slash is ordinary input), but a
 * dot segment cannot be a Jenkins item name and would walk the URL elsewhere.
 */
export const nameSegments = (name: string, what = "job name"): string[] => {
  if (typeof name !== "string")
    throw new JenkinsInputError(`Invalid ${what} ${show(name)}: expected a string`)
  const segments = name.split("/").filter(Boolean)
  if (segments.some(isDotSegment))
    throw new JenkinsInputError(
      `Invalid ${what} ${show(name)}: "." and ".." are not item names`,
    )
  return segments
}

/** One encoded path segment: a node or view name, never containing a traversal. */
export const pathSegment = (value: string, what: string): string => {
  if (typeof value !== "string" || value === "" || isDotSegment(value))
    throw new JenkinsInputError(`Invalid ${what} ${show(value)}`)
  return encodeURIComponent(value)
}

/**
 * A build reference for a URL: a positive integer (number or digit string) or
 * one of Jenkins' build permalinks.
 */
export const buildRef = (build: unknown): string => {
  if (typeof build === "number") {
    if (Number.isSafeInteger(build) && build > 0) return String(build)
  } else if (typeof build === "string") {
    if (/^[1-9]\d*$/.test(build) && Number.isSafeInteger(Number(build)))
      return build
    if ((BUILD_PERMALINKS as readonly string[]).includes(build)) return build
  }
  throw new JenkinsInputError(
    `Invalid build ${show(build)}: expected a positive integer or one of ${BUILD_PERMALINKS.join(", ")}`,
  )
}

/** A queue item id: a non-negative integer (number or digit string). */
export const queueId = (id: unknown): string => {
  const s = typeof id === "number" ? String(id) : id
  if (
    typeof s === "string" &&
    /^\d+$/.test(s) &&
    Number.isSafeInteger(Number(s))
  )
    return String(Number(s))
  throw new JenkinsInputError(`Invalid queue item id ${show(id)}: expected an integer`)
}

/** A pipeline flow-node id (stage or step): letters, digits, `_` and `-` only. */
export const flowNodeId = (id: unknown, what = "flow node id"): string => {
  const s = typeof id === "number" && Number.isSafeInteger(id) ? String(id) : id
  if (typeof s === "string" && /^[A-Za-z0-9_-]+$/.test(s)) return s
  throw new JenkinsInputError(`Invalid ${what} ${show(id)}`)
}

/**
 * An artifact's path relative to the build's artifact root, each segment
 * encoded. Empty, `.` and `..` segments are refused rather than dropped: an
 * artifact path comes from the build's own artifact list, so an odd one is
 * either a bug or an attempt to leave the artifact directory.
 */
export const artifactPath = (relativePath: unknown): string => {
  if (typeof relativePath !== "string" || relativePath === "")
    throw new JenkinsInputError(
      `Invalid artifact path ${show(relativePath)}: expected a non-empty string`,
    )
  const segments = relativePath.split("/")
  if (segments.some((s) => s === "" || isDotSegment(s)))
    throw new JenkinsInputError(
      `Invalid artifact path ${show(relativePath)}: empty, "." and ".." segments are not allowed`,
    )
  return segments.map(encodeURIComponent).join("/")
}
