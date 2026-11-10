export interface JenkinsCrumb {
  crumb: string
  crumbRequestField: string
}
export interface JenkinsBuildRef {
  number: number
  url?: string
}
export interface JenkinsJob {
  name?: string
  fullName?: string
  url?: string
  color?: string
  jobs?: JenkinsJob[]
  lastBuild?: { number: number }
  builds?: Array<JenkinsBuildRef>
  artifacts?: JenkinsArtifact[]
  error?: string
}
export interface JenkinsArtifact {
  fileName: string
  relativePath: string
  size?: number
}
export interface JenkinsBuild {
  number: number
  building?: boolean
  result?: string
  artifacts?: JenkinsArtifact[]
  [k: string]: any
}
export interface JenkinsParameterDefinition {
  name: string
  type?: string
  description?: string
  defaultValue?: unknown
  choices?: string[]
}
export interface JenkinsCommit {
  id?: string
  author?: string
  msg?: string
  date?: string
}
export interface JenkinsBuildChanges {
  number: number
  causes: string[]
  culprits: string[]
  commits: JenkinsCommit[]
}
export interface ProgressiveLogOptions {
  signal?: AbortSignal
}
export type RequestAs = "buffer" | undefined
export interface RequestOptions {
  method?: string
  headers?: Record<string, string>
  as?: RequestAs
  body?: any
}

export interface DiagnoseBuildOptions {
  lines?: number
  maxBytes?: number
  maxTests?: number
  // Replaces the default error patterns used for `errorLines`.
  errorPatterns?: RegExp[]
}

export interface ErrorBlock {
  // 1-based line number of the block's first line in the step log
  line: number
  text: string[]
}

export interface FailedStep {
  name: string
  status: string
  logTail: string
  // Error-looking lines from the whole step log with ±2 lines of context:
  // [] when the log was scanned and nothing matched, null when there was no log.
  errorLines: ErrorBlock[] | null
  logLineCount: number | null
  // Report URLs the step printed; null when there was no log
  reportLinks: string[] | null
}

export interface FailedStage {
  name: string
  status: string
  steps: FailedStep[]
}

export interface FailedTestCase {
  name: string
  error: string | null
  stackHead: string | null
}

export interface TestSummary {
  failed: number
  total: number
  first: FailedTestCase[]
}

export interface DiagnoseBuildResult {
  job: string
  build: number
  result: string | null
  url: string
  failedStages: FailedStage[]
  tests: TestSummary | null
  hints: string[]
}

export interface JenkinsNode {
  name: string
  offline: boolean
  idle: boolean
  numExecutors: number
  busyExecutors: number
  temporarilyOffline: boolean
  offlineCauseReason: string
}

export interface JenkinsNodeDetail {
  name: string
  offline: boolean
  temporarilyOffline: boolean
  offlineCauseReason: string
  idle: boolean
  numExecutors: number
  assignedLabels: string[]
  monitorData: Record<string, unknown>
}

export interface JenkinsViewJob {
  name: string
  url: string
  color?: string
}

export interface JenkinsView {
  name: string
  url: string
  jobs: JenkinsViewJob[]
}

export interface JenkinsViewDetail extends JenkinsView {
  description: string
}

export interface JenkinsSystemInfo {
  nodeDescription: string
  nodeName: string
  numExecutors: number
  mode: string
  quietingDown: boolean
  useCrumbs: boolean
  useSecurity: boolean
}

export interface JenkinsPlugin {
  shortName: string
  longName: string
  version: string
  enabled: boolean
  active: boolean
  hasUpdate: boolean
}
