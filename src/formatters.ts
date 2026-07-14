import type { JenkinsBuild } from "./types.js"

// Surface-agnostic status classification. This is the single semantic decision
// ("what state is this build in?") that every presentation layer maps to its
// own colour vocabulary — CLI chalk, ink-ui tokens, an OpenTUI palette. No
// colour and no framework live here, so the decision is written exactly once.
export type BuildStatusToken =
  | "success"
  | "failure"
  | "unstable"
  | "aborted"
  | "running"
  | "unknown"

export const buildStatusToken = (build: JenkinsBuild): BuildStatusToken => {
  if (build.building) return "running"
  switch (build.result) {
    case "SUCCESS":
      return "success"
    case "FAILURE":
      return "failure"
    case "UNSTABLE":
      return "unstable"
    case "ABORTED":
      return "aborted"
    default:
      return "unknown"
  }
}

// Elapsed build time as a compact human string ("820ms" / "42s" / "3m" / "2h").
// A running build is measured against now; a finished one uses its duration.
export const fmtDuration = (build: JenkinsBuild): string => {
  const d = build.building
    ? Date.now() - (build.timestamp || Date.now())
    : build.duration || 0
  if (d < 1000) return `${d}ms`
  if (d < 60000) return `${Math.round(d / 1000)}s`
  if (d < 3600000) return `${Math.round(d / 60000)}m`
  return `${Math.round(d / 3600000)}h`
}

// How long ago the build started ("5s ago" / "12m ago" / "3h ago" / "2d ago").
export const fmtAge = (build: JenkinsBuild): string => {
  if (!build.timestamp) return "-"
  const ms = Date.now() - build.timestamp
  if (ms < 60000) return `${Math.max(1, Math.round(ms / 1000))}s ago`
  if (ms < 3600000) return `${Math.round(ms / 60000)}m ago`
  if (ms < 86400000) return `${Math.round(ms / 3600000)}h ago`
  return `${Math.round(ms / 86400000)}d ago`
}
