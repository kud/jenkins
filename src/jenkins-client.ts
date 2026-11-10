import {
  JenkinsJob,
  JenkinsBuild,
  JenkinsArtifact,
  JenkinsCrumb,
  JenkinsParameterDefinition,
  JenkinsBuildChanges,
  DiagnoseBuildOptions,
  DiagnoseBuildResult,
  FailedStage,
  FailedStep,
  ErrorBlock,
  TestSummary,
  FailedTestCase,
  JenkinsNode,
  JenkinsNodeDetail,
  JenkinsView,
  JenkinsViewDetail,
  JenkinsSystemInfo,
  JenkinsPlugin,
} from "./types.js"
import { cleanStepLog, findErrorLines, findReportLinks } from "./error-lines.js"

const getFetch = () => globalThis.fetch as typeof fetch
const joinUrl = (base: string, path: string): string =>
  base.replace(/\/$/, "") + "/" + path.replace(/^\//, "")
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

class HttpError extends Error {
  status: number
  body?: string
  constructor(status: number, message: string, body?: string) {
    super(message)
    this.status = status
    this.body = body
  }
}

interface InternalRequestOptions {
  method?: string
  headers?: Record<string, string>
  as?: "buffer"
  body?: any
}

// REST path for a (possibly nested) job: "folder/job" → "job/folder/job/job",
// encoding each segment. encodeURIComponent alone turns "/" into %2F, which
// breaks nested folder jobs; splitting on "/" and re-interleaving "job/" is the
// correct Jenkins path form.
//
// ⚠ EMPTY SEGMENTS ARE DROPPED, and that is not cosmetic. A stray leading,
// trailing or doubled slash used to survive into the URL as `job//job/...`,
// which Jenkins answers with a 404 — indistinguishable from the job genuinely
// not existing, so the caller goes looking for a deleted job rather than for
// the extra slash they typed. Job names arrive from config files, CLI arguments
// and API responses, so an untidy one is ordinary input rather than a
// programming error, and must not be able to look like an absence.
export const jobPath = (job: string): string =>
  "job/" + job.split("/").filter(Boolean).map(encodeURIComponent).join("/job/")

// Split a full item name into the folder that will hold it and its own name.
// createItem is posted to the parent folder, never to the item's own path.
const splitItemName = (fullName: string): { parent: string; name: string } => {
  const segments = fullName.split("/").filter(Boolean)
  if (segments.length === 0)
    throw new Error("Job name must be a non-empty Jenkins full name")
  const name = segments.pop() as string
  return { parent: segments.join("/"), name }
}

export class JenkinsClient {
  baseUrl: string
  user: string
  token: string
  authHeader: string
  timeout: number
  retries: number
  retryDelay: number

  // ⚠ CREDENTIALS ARE OPTIONAL, AND AN ABSENT ONE MUST SEND NO HEADER AT ALL.
  // A Jenkins that allows anonymous read is a real configuration, and this used
  // to build the header unconditionally — so omitting the user and token still
  // sent a Basic credential, well formed and authenticating as nobody
  // (`Basic Og==`, or base64("undefined:undefined") from an untyped caller).
  // Depending on the server that is a 401 or an audit-log entry for a login
  // nobody attempted, and neither reads as "no credentials were configured".
  //
  // The fields stay typed `string` and default to `""` rather than becoming
  // optional: `client.user` is public, and widening it to `string | undefined`
  // would be a breaking change for consumers over a case they do not have.
  //
  // `auth.bearer` sends `Authorization: Bearer <token>` instead, for a Jenkins
  // behind an OIDC or token plugin, and wins over a user and token when both
  // are given, so a configuration naming both cannot quietly fall back to Basic.
  constructor(
    baseUrl: string,
    user = "",
    token = "",
    opts: {
      timeout?: number
      retries?: number
      retryDelay?: number
      auth?: { bearer: string }
    } = {},
  ) {
    this.baseUrl = baseUrl
    this.user = user
    this.token = token
    this.authHeader = opts.auth?.bearer
      ? `Bearer ${opts.auth.bearer}`
      : user && token
        ? "Basic " + Buffer.from(`${user}:${token}`).toString("base64")
        : ""
    const timeout = opts.timeout ?? 15000
    const retries = opts.retries ?? 0
    this.timeout = Number.isFinite(timeout) && timeout > 0 ? timeout : 15000
    this.retries =
      Number.isFinite(retries) && retries >= 0 && retries < 10 ? retries : 0
    this.retryDelay = opts.retryDelay ?? 500 // backoff base ms
    this._resolvedPathCache = new Map()
  }

  private _resolvedPathCache: Map<string, string>

  // Spread rather than assigned, so no-credentials sends NO Authorization
  // header rather than an empty one. An empty `Authorization:` is not the same
  // request as none: some servers reject it outright and some log it, and
  // either way the wire stops matching what was configured.
  private get authHeaders(): Record<string, string> {
    return this.authHeader ? { Authorization: this.authHeader } : {}
  }

  private async _fetchWithTimeout(
    url: string,
    init: RequestInit = {},
  ): Promise<Response> {
    const controller = new AbortController()
    const id = setTimeout(() => controller.abort(), this.timeout)
    try {
      const res = await getFetch()(url, { ...init, signal: controller.signal })
      return res
    } finally {
      clearTimeout(id)
    }
  }

  private _shouldRetry(
    res: Response | undefined,
    err: unknown,
    attempt: number,
  ): boolean {
    if (attempt >= this.retries) return false
    if (err) return true // network / abort
    if (!res) return true
    if (res.status >= 500) return true
    return false
  }

  private _request(
    path: string,
    opts: InternalRequestOptions & { as: "buffer" },
  ): Promise<Buffer>
  private _request<T = any>(
    path: string,
    opts?: InternalRequestOptions,
  ): Promise<T>
  private async _request(
    path: string,
    opts: InternalRequestOptions = {},
  ): Promise<any> {
    const url = joinUrl(this.baseUrl, path)
    let attempt = 0
    while (true) {
      // retry loop
      let res: Response | undefined
      let err: unknown
      try {
        const { as, ...forward } = opts
        res = await this._fetchWithTimeout(url, {
          headers: { ...this.authHeaders, ...(opts.headers || {}) },
          method: opts.method,
          body: opts.body,
          ...forward,
        })
      } catch (e) {
        err = e
      }
      if (!err && res && res.ok) {
        const ct = res.headers.get("content-type") || ""
        if (opts.as === "buffer") {
          const ab = await res.arrayBuffer()
          return Buffer.from(ab)
        }
        if (ct.includes("application/json")) return res.json()
        return res.text()
      }
      if (this._shouldRetry(res, err, attempt)) {
        await sleep(this.retryDelay * (attempt + 1))
        attempt++
        continue
      }
      if (err) {
        throw new HttpError(
          res?.status || 0,
          `Request failed ${url}: ${(err as Error).message}`,
        )
      }
      const body = res ? (await res.text()).slice(0, 300) : ""
      throw new HttpError(
        res?.status || 0,
        `HTTP ${res?.status} ${res?.statusText}: ${body}`,
        body,
      )
    }
  }

  // ⚠ A CRUMB BELONGS TO THE WEB SESSION IT WAS ISSUED IN. Jenkins binds it to
  // the session cookie set on the crumbIssuer response, so a write must carry
  // that cookie alongside the crumb or it is refused with 403 — reads keep
  // working, which made the client look healthy while every trigger failed.
  // API-token Basic auth is exempt from the check; bearer setups usually are
  // not. The crumb and cookie are kept together, and _write re-issues both
  // once when Jenkins expires the session (a 403 on a crumbed write).
  private _crumb: JenkinsCrumb | null = null
  private _cookie = ""

  private async _getCrumb(): Promise<JenkinsCrumb | null> {
    if (this._crumb) return this._crumb
    try {
      const res = await this._fetchWithTimeout(
        joinUrl(this.baseUrl, "crumbIssuer/api/json"),
        { headers: { ...this.authHeaders } },
      )
      if (!res.ok) return null
      const headers = res.headers as Headers & { getSetCookie?: () => string[] }
      const setCookies =
        typeof headers.getSetCookie === "function"
          ? headers.getSetCookie()
          : [headers.get("set-cookie")].filter((c): c is string => !!c)
      const c = (await res.json()) as JenkinsCrumb
      if (!c || typeof c !== "object" || !(c.crumb || c.crumbRequestField))
        return null
      this._cookie = setCookies.map((s) => s.split(";")[0].trim()).join("; ")
      this._crumb = c
      return c
    } catch {
      return null
    }
  }

  // Every mutating request: crumb and session cookie attached, one re-issue
  // and retry when a crumbed write comes back 403. Resolves with the response
  // whatever its status; callers classify it.
  private async _write(url: string, init: RequestInit = {}): Promise<Response> {
    const send = async (crumb: JenkinsCrumb | null) => {
      const headers: Record<string, string> = {
        ...this.authHeaders,
        ...((init.headers as Record<string, string>) || {}),
      }
      if (crumb?.crumb && crumb.crumbRequestField)
        headers[crumb.crumbRequestField] = crumb.crumb
      if (crumb && this._cookie) headers.Cookie = this._cookie
      return this._fetchWithTimeout(url, { ...init, method: "POST", headers })
    }
    const crumb = await this._getCrumb()
    const res = await send(crumb)
    if (res.status !== 403 || !crumb) return res
    this._crumb = null
    this._cookie = ""
    return send(await this._getCrumb())
  }

  // ⚠ WRITES NEVER RETRY. _request retries 5xx when `retries` is set, which is
  // safe for reads and wrong for a POST: a createItem that timed out may have
  // landed, and a second attempt then fails on a job that now exists. The one
  // exception is _write's crumb re-issue: a 403 was refused, so nothing landed.
  // Throws HttpError on 4xx/5xx so _requestWithPathResolution can still re-route a 404.
  private async _post(
    path: string,
    opts: {
      body?: string
      contentType?: string
      redirect?: RequestRedirect
    } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = {}
    if (opts.contentType) headers["Content-Type"] = opts.contentType
    const url = joinUrl(this.baseUrl, path)
    let res: Response
    try {
      res = await this._write(url, {
        headers,
        body: opts.body,
        redirect: opts.redirect,
      })
    } catch (e) {
      throw new HttpError(0, `Request failed ${url}: ${(e as Error).message}`)
    }
    if (res.status >= 400) {
      const body = (await res.text()).slice(0, 300)
      throw new HttpError(
        res.status,
        `HTTP ${res.status} ${res.statusText}: ${body}`,
        body,
      )
    }
    return res
  }

  /**
   * Try a request with the plain jobPath. On 404, resolve the true path by
   * walking the job hierarchy and checking _class at each level. Cache the
   * resolved path so subsequent calls go straight there.
   */
  private async _requestWithPathResolution<T>(
    job: string,
    suffix: string,
    requestFn: (path: string) => Promise<T>,
  ): Promise<T> {
    const cached = this._resolvedPathCache.get(job)
    if (cached) return requestFn(cached + suffix)

    const plainPath = jobPath(job) + suffix
    try {
      return await requestFn(plainPath)
    } catch (err) {
      if (!(err instanceof HttpError) || err.status !== 404) throw err
    }

    // Walk the path to find the real structure
    const resolvedPath = await this._resolveMultibranchPath(job)
    if (resolvedPath !== plainPath) {
      this._resolvedPathCache.set(job, resolvedPath)
      return requestFn(resolvedPath + suffix)
    }

    // Resolution found nothing different; surface original 404
    throw new HttpError(
      404,
      `HTTP 404 Not Found: ${joinUrl(this.baseUrl, plainPath)}`,
    )
  }

  /**
   * The REST path for a job ("job/org/job/repo/job/feature%2Fx"), with the
   * slashes of a multibranch branch name kept inside one segment.
   *
   * For callers building their own requests with `tree()`: `jobPath()` is
   * right for every job outside a multibranch project and costs nothing, so try
   * it first and call this on its 404. It walks the hierarchy, one request per
   * segment, and the answer is cached for the life of the client.
   *
   * @example
   * const path = await client.resolveJobPath("repo/feature/x")
   * await client.tree(`${path}/api/json`, "builds[number,result]{0,5}")
   */
  async resolveJobPath(job: string): Promise<string> {
    const cached = this._resolvedPathCache.get(job)
    if (cached) return cached
    const resolved = await this._resolveMultibranchPath(job)
    if (resolved !== jobPath(job)) this._resolvedPathCache.set(job, resolved)
    return resolved
  }

  /**
   * Walk the job path segment by segment, fetching _class at each level.
   * When a WorkflowMultiBranchProject is found, all remaining segments form
   * the branch name (joined with "/" and encoded once).
   * When an OrganizationFolder is found, the next segment is the repo
   * (a multibranch project), and segments after that form the branch.
   */
  private async _resolveMultibranchPath(job: string): Promise<string> {
    const segments = job.split("/").filter(Boolean)
    if (segments.length === 0) return jobPath(job)

    let pathSoFar = ""
    let multibranchIndex = -1
    let orgFolderIndex = -1

    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i]
      const encoded = encodeURIComponent(segment)
      pathSoFar = pathSoFar ? `${pathSoFar}/job/${encoded}` : `job/${encoded}`

      // Fetch _class at this level
      let klass: string | undefined
      try {
        const data = await this._request<{ _class?: string }>(
          `${pathSoFar}/api/json?tree=_class`,
        )
        klass = data?._class
      } catch {
        // If we can't fetch _class, assume plain path is correct
        continue
      }

      if (!klass) continue

      if (klass.includes("WorkflowMultiBranchProject")) {
        multibranchIndex = i
        break
      }
      if (klass.includes("OrganizationFolder")) {
        orgFolderIndex = i
        // Continue walking; the repo (next level) should be the multibranch project
      }
    }

    // Reconstruct the correct path
    if (multibranchIndex >= 0) {
      // Segments 0..multibranchIndex are folders/project; the rest is the branch name
      const prefixSegments = segments.slice(0, multibranchIndex + 1)
      const branchSegments = segments.slice(multibranchIndex + 1)
      if (branchSegments.length === 0) return jobPath(job) // No branch segment; plain path is fine

      const prefixPath = prefixSegments.map(encodeURIComponent).join("/job/")
      const branchName = branchSegments.join("/")
      const branchEncoded = encodeURIComponent(branchName)
      return `job/${prefixPath}/job/${branchEncoded}`
    }

    if (orgFolderIndex >= 0 && orgFolderIndex + 1 < segments.length) {
      // Organization folder -> repo (multibranch) -> branch
      // The repo is at orgFolderIndex + 1; branch is everything after
      const prefixSegments = segments.slice(0, orgFolderIndex + 2) // org + repo
      const branchSegments = segments.slice(orgFolderIndex + 2)
      if (branchSegments.length === 0) return jobPath(job)

      const prefixPath = prefixSegments.map(encodeURIComponent).join("/job/")
      const branchName = branchSegments.join("/")
      const branchEncoded = encodeURIComponent(branchName)
      return `job/${prefixPath}/job/${branchEncoded}`
    }

    // No multibranch/org folder detected; plain path is correct
    return jobPath(job)
  }

  /**
   * Any Jenkins remote-access endpoint, with a `tree` filter you choose.
   *
   * `listJobs()` and friends fetch a fixed `tree`, which is right for the CLI
   * and wrong for anything that needs a field they did not think to ask for —
   * `healthReport`, `_class`, or `lastBuild[actions[causes[*]]]`, which is the
   * only way to learn what actually triggered a build. Without this, a consumer
   * has to hand-roll a second HTTP client beside this one and re-implement
   * auth, retry and crumb handling to reach one extra field.
   *
   * ⚠ `path` is a Jenkins API path, not a job name — pass `api/json` for the
   * instance, or build a nested one with `jobPath()`. Folders nest in the URL
   * (`/job/org/job/repo/job/branch`), so encoding a slashed name as one segment
   * returns a 404 that reads exactly like a job that does not exist.
   *
   * @example
   * await client.tree("api/json", "jobs[name,_class,lastBuild[result]]")
   * await client.tree(`${jobPath("org/repo/main")}/api/json`, "builds[number,result]{0,10}")
   */
  async tree<T = any>(path: string, tree?: string): Promise<T> {
    const sep = path.includes("?") ? "&" : "?"
    const suffix = tree ? `${sep}tree=${encodeURIComponent(tree)}` : ""
    return this._request<T>(`${path}${suffix}`)
  }

  async getJob(job: string): Promise<JenkinsJob> {
    return this._requestWithPathResolution(job, "/api/json?depth=1", (path) =>
      this._request<JenkinsJob>(path),
    )
  }

  async getBuild(job: string, buildNumber?: number): Promise<JenkinsBuild> {
    if (!buildNumber) {
      const jobInfo = await this.getJob(job)
      const number = jobInfo.lastBuild?.number
      if (!number) throw new Error("No lastBuild found")
      buildNumber = number
    }
    return this._requestWithPathResolution(
      job,
      `/${buildNumber}/api/json`,
      (path) => this._request<JenkinsBuild>(path),
    )
  }

  async getConsoleText(job: string, buildNumber?: number): Promise<string> {
    if (!buildNumber) {
      const jobInfo = await this.getJob(job)
      const number = jobInfo.lastBuild?.number
      if (!number) throw new Error("No lastBuild found")
      buildNumber = number
    }
    return this._requestWithPathResolution(
      job,
      `/${buildNumber}/consoleText`,
      (path) => this._request<string>(path),
    )
  }

  async streamConsole(
    job: string,
    buildNumber: number | undefined,
    onChunk: (chunk: string) => void,
    intervalMs = 3000,
    opts: { signal?: AbortSignal } = {},
  ): Promise<void> {
    if (!buildNumber) {
      const jobInfo = await this.getJob(job)
      const number = jobInfo.lastBuild?.number
      if (!number) throw new Error("No lastBuild found")
      buildNumber = number
    }

    const resolvedPath = await this._getResolvedJobPath(job)
    let start = 0
    const signal = opts.signal
    const isAborted = () =>
      signal && (signal.aborted || (signal as any).reason?.aborted)
    let finished = false
    while (!finished) {
      if (isAborted()) break
      const urlPath = `${resolvedPath}/${buildNumber}/logText/progressiveText?start=${start}`
      const url = joinUrl(this.baseUrl, urlPath)
      const res = await this._fetchWithTimeout(url, {
        headers: { ...this.authHeaders },
      })
      if (!res.ok) throw new Error(`HTTP ${res.status} streaming logs`)
      if (isAborted()) break
      const text = await res.text()
      if (text && !isAborted()) onChunk(text)
      const newStart = parseInt(res.headers.get("x-text-size") || "0", 10)
      const more = res.headers.get("x-more-data") === "true"
      start = newStart
      if (!more) {
        const build = await this.getBuild(job, buildNumber)
        const building = build.building === true
        if (!building) finished = true
        else if (!isAborted()) await sleep(intervalMs)
      } else {
        if (isAborted()) break
        await sleep(intervalMs)
      }
    }
  }

  /**
   * Get the resolved job path (with multibranch handling), caching the result.
   * Used by methods that build URLs directly with joinUrl instead of _request.
   */
  private async _getResolvedJobPath(job: string): Promise<string> {
    const plainPath = jobPath(job)
    const cached = this._resolvedPathCache.get(job)
    if (cached) return cached
    if (!job.includes("/")) return plainPath

    try {
      await this._request(`${plainPath}/api/json?tree=_class`)
      return plainPath
    } catch (err) {
      if (!(err instanceof HttpError) || err.status !== 404) return plainPath
    }

    try {
      const resolved = await this._resolveMultibranchPath(job)
      this._resolvedPathCache.set(job, resolved)
      return resolved
    } catch {
      this._resolvedPathCache.set(job, plainPath)
      return plainPath
    }
  }

  async triggerBuild(
    job: string,
  ): Promise<{ queued: true; location: string | null }> {
    const resolvedPath = await this._getResolvedJobPath(job)
    const url = joinUrl(this.baseUrl, `${resolvedPath}/build`)
    const res = await this._write(url)
    if ([200, 201, 202].includes(res.status))
      return { queued: true, location: res.headers.get("location") }
    throw new Error(`Trigger failed: ${res.status} ${res.statusText}`)
  }

  async triggerBuildWithParameters(
    job: string,
    params: Record<string, string> = {},
  ): Promise<{ queued: true; location: string | null }> {
    const headers = { "Content-Type": "application/x-www-form-urlencoded" }
    const body = new URLSearchParams()
    for (const [k, v] of Object.entries(params)) body.append(k, v)
    const resolvedPath = await this._getResolvedJobPath(job)
    const url = joinUrl(this.baseUrl, `${resolvedPath}/buildWithParameters`)
    const res = await this._write(url, { headers, body: body.toString() })
    if ([200, 201, 202].includes(res.status))
      return { queued: true, location: res.headers.get("location") }
    throw new Error(
      `Parameterized trigger failed: ${res.status} ${res.statusText}`,
    )
  }

  async stopBuild(
    job: string,
    buildNumber: number,
  ): Promise<{ stopped: true }> {
    const resolvedPath = await this._getResolvedJobPath(job)
    const url = joinUrl(this.baseUrl, `${resolvedPath}/${buildNumber}/stop`)
    const res = await this._write(url)
    if (![200, 201, 202].includes(res.status))
      throw new Error(`Stop failed: ${res.status} ${res.statusText}`)
    return { stopped: true }
  }

  async getQueue(): Promise<any> {
    // Domain typing optional for now
    return this._request<any>("queue/api/json")
  }

  async cancelQueueItem(id: number | string): Promise<{ cancelled: true }> {
    const url = joinUrl(this.baseUrl, `queue/cancelItem?id=${id}`)
    const res = await this._write(url)
    if (![200, 201, 202, 302].includes(res.status))
      throw new Error(`Cancel queue failed: ${res.status} ${res.statusText}`)
    return { cancelled: true }
  }

  async getTestReport(job: string, buildNumber: number): Promise<any> {
    // refine later
    return this._requestWithPathResolution(
      job,
      `/${buildNumber}/testReport/api/json`,
      (path) => this._request<any>(path),
    )
  }

  // buildNumber omitted => resolve Jenkins' `lastBuild` permalink server-side,
  // so `stages <job>` targets the latest build (matching getBuild/getBuildChanges).
  async getPipelineStages(
    job: string,
    buildNumber?: number | string,
  ): Promise<any> {
    const ref = buildNumber ?? "lastBuild"
    return this._requestWithPathResolution(
      job,
      `/${ref}/wfapi/describe`,
      (path) => this._request<any>(path),
    )
  }

  // The steps inside a single pipeline stage node (from the stage `id` returned
  // by getPipelineStages) → { stageFlowNodes: [{ id, name, status, ... }] }.
  async getStageSteps(
    job: string,
    buildNumber: number | string,
    nodeId: string,
  ): Promise<any> {
    return this._requestWithPathResolution(
      job,
      `/${buildNumber}/execution/node/${nodeId}/wfapi/describe`,
      (path) => this._request<any>(path),
    )
  }

  // A single step's log text. The wfapi log endpoint wraps it in { text } and
  // returns Jenkins' HTML-annotated console (<a href=…> links, entities), so we
  // strip tags and decode entities down to plain text.
  async getStepLog(
    job: string,
    buildNumber: number | string,
    stepId: string,
  ): Promise<string> {
    const r = await this._requestWithPathResolution(
      job,
      `/${buildNumber}/execution/node/${stepId}/wfapi/log`,
      (path) => this._request<any>(path),
    )
    const raw = (r && r.text) || ""
    return raw
      .replace(/<[^>]+>/g, "")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, "&")
  }

  // Build parameter definitions — so a caller knows what to pass to `build --param`.
  async getJobParameters(job: string): Promise<JenkinsParameterDefinition[]> {
    const data = await this._requestWithPathResolution(
      job,
      "/api/json?tree=property[parameterDefinitions[name,type,description,choices,defaultParameterValue[value]]]",
      (path) => this._request<any>(path),
    )
    const defs = (data?.property || []).flatMap(
      (p: any) => p.parameterDefinitions || [],
    )
    return defs.map((d: any) => ({
      name: d.name,
      type: d.type,
      description: d.description || undefined,
      defaultValue: d.defaultParameterValue?.value,
      choices: d.choices || undefined,
    }))
  }

  // Trigger cause, culprits, and SCM commits for a build — the core triage info.
  async getBuildChanges(
    job: string,
    buildNumber?: number,
  ): Promise<JenkinsBuildChanges> {
    if (!buildNumber) {
      const jobInfo = await this.getJob(job)
      const number = jobInfo.lastBuild?.number
      if (!number) throw new Error("No lastBuild found")
      buildNumber = number
    }
    const tree =
      "number,actions[causes[shortDescription]],changeSets[items[commitId,msg,date,author[fullName]]],culprits[fullName]"
    const data = await this._requestWithPathResolution(
      job,
      `/${buildNumber}/api/json?tree=${tree}`,
      (path) => this._request<any>(path),
    )
    const causes = (data.actions || [])
      .flatMap((a: any) => a.causes || [])
      .map((c: any) => c.shortDescription)
      .filter(Boolean)
    const culprits = (data.culprits || [])
      .map((c: any) => c.fullName)
      .filter(Boolean)
    const commits = (data.changeSets || [])
      .flatMap((cs: any) => cs.items || [])
      .map((it: any) => ({
        id: it.commitId,
        author: it.author?.fullName,
        msg: it.msg,
        date: it.date,
      }))
    return { number: data.number ?? buildNumber, causes, culprits, commits }
  }

  async listBuilds(job: string, limit = 10): Promise<JenkinsBuild[]> {
    const jobInfo = await this.getJob(job)
    const recent = (jobInfo.builds || []).slice(0, limit)
    // Fetch build details concurrently (was a serial await-loop → N round-trips
    // in series on every job switch / auto-refresh). Order and skip-on-failure
    // are preserved.
    const settled = await Promise.all(
      recent.map((ref) => this.getBuild(job, ref.number).catch(() => null)),
    )
    return settled.filter((b): b is JenkinsBuild => b !== null)
  }

  async getArtifacts(
    job: string,
    buildNumber?: number,
  ): Promise<{ build: JenkinsBuild; artifacts: JenkinsArtifact[] }> {
    const build = await this.getBuild(job, buildNumber)
    return { build, artifacts: build.artifacts || [] }
  }

  async downloadArtifact(
    job: string,
    buildNumber: number,
    relativePath: string,
  ): Promise<Buffer> {
    return this._requestWithPathResolution(
      job,
      `/${buildNumber}/artifact/${relativePath}`,
      (path) => this._request(path, { as: "buffer" }),
    )
  }

  async getSpecificJobs(jobNames: string[]): Promise<JenkinsJob[]> {
    const results: JenkinsJob[] = []
    for (const jobName of jobNames) {
      try {
        const job = await this.getJob(jobName)
        if (!job.fullName) job.fullName = jobName
        results.push(job)
      } catch (error) {
        // Add detailed error information based on the error type
        let errorMessage = `Failed to load job '${jobName}'`

        if (error.status === 404) {
          errorMessage = `Job '${jobName}' not found`
        } else if (error.status === 403) {
          errorMessage = `Access denied to job '${jobName}'`
        } else if (error.status === 401) {
          errorMessage = `Authentication required for job '${jobName}'`
        } else if (error.status >= 500) {
          errorMessage = `Server error loading job '${jobName}'`
        } else if (error.message) {
          errorMessage = `${jobName}: ${error.message}`
        }

        results.push({
          name: jobName,
          fullName: jobName,
          url: `${this.baseUrl}/job/${encodeURIComponent(jobName)}/`,
          color: "disabled",
          error: errorMessage,
        } as JenkinsJob)
      }
    }
    return results
  }

  // Fetch the top-level job list. A failure here means Jenkins is unreachable
  // (bad URL/credentials, server down, or — most often — off the VPN), so we
  // rethrow with a hint rather than letting callers swallow it into an empty
  // result. Distinct from per-folder crawl errors, which callers tolerate.
  private async _fetchRoot(): Promise<{ jobs?: JenkinsJob[] }> {
    try {
      return await this._request<{ jobs?: JenkinsJob[] }>(
        `api/json?tree=jobs[name,url,color]`,
      )
    } catch (e) {
      throw new Error(
        `Cannot reach Jenkins at ${this.baseUrl}: ${(e as Error).message}. ` +
          `Check the server URL and that you're connected (VPN?).`,
      )
    }
  }

  // List only the top-level jobs (a single request). This is the fast,
  // predictable default for "list the jobs" — folders appear as entries you
  // can drill into, rather than triggering a full recursive tree walk.
  async listJobs(): Promise<JenkinsJob[]> {
    const root = await this._fetchRoot()
    for (const j of root.jobs || []) if (!j.fullName) j.fullName = j.name || ""
    return root.jobs || []
  }

  async searchJobs(query: string, limit = 50): Promise<JenkinsJob[]> {
    // New BFS recursive traversal without artificial depth restriction.
    // If limit === 0 treat as unlimited (subject to safety cap) to support large instances.
    const safetyCap = 5000 // Prevent pathological traversal from overwhelming UI.
    const effectiveLimit = limit === 0 ? safetyCap : limit

    // Root fetch is the reachability probe: if it fails, every folder crawl
    // below is doomed too, so surface the error instead of returning an empty
    // list that reads as "no matches" (masking e.g. an unreachable server /
    // missing VPN). Inner folder failures stay forgiving further down.
    const root = await this._fetchRoot()

    const queue: Array<{ job: JenkinsJob; path: string[] }> = []
    const results: JenkinsJob[] = []

    const enqueueChildren = (parent: JenkinsJob, path: string[]) => {
      if (!parent.jobs) return
      for (const child of parent.jobs) {
        const name = child.name || ""
        const fullParts = [...path, name]
        if (!child.fullName)
          child.fullName = fullParts.filter(Boolean).join("/")
        queue.push({ job: child, path: fullParts })
      }
    }

    // Prime queue with first level
    for (const j of root.jobs || []) {
      const name = j.name || ""
      if (!j.fullName) j.fullName = name
      queue.push({ job: j, path: [name] })
    }

    const qLower = query.toLowerCase()

    while (queue.length > 0 && results.length < effectiveLimit) {
      const { job, path } = queue.shift()!
      // If job might be a folder we attempt to fetch its children lazily.
      // Heuristic: folder jobs often have color undefined and need another API call to list nested jobs.
      // We call API only if we haven't already populated jobs array.
      if (job.jobs === undefined) {
        try {
          const data = await this._request<JenkinsJob>(
            `job/${encodeURIComponent(job.name || "")}/api/json?tree=name,url,color,jobs[name,url,color]`,
          )
          if (data && data.jobs) {
            job.jobs = data.jobs
            enqueueChildren(job, path)
          }
        } catch {
          /* ignore individual folder failures */
        }
      } else if (Array.isArray(job.jobs) && job.jobs.length > 0) {
        enqueueChildren(job, path)
      }

      const fullName = job.fullName || job.name || ""
      if (!qLower || fullName.toLowerCase().includes(qLower)) {
        results.push(job)
      }
    }

    return results.slice(0, effectiveLimit)
  }

  // Incremental full traversal with progress callback; returns full list (bounded by safety cap) once done.
  async searchJobsIncremental(
    query: string,
    opts: {
      limit?: number
      onBatch?: (
        jobs: JenkinsJob[],
        stats: { processed: number; queued: number; total: number },
      ) => void
      concurrency?: number
    } = {},
  ): Promise<JenkinsJob[]> {
    const limit = opts.limit ?? 0 // 0 = unlimited
    const safetyCap = 5000
    const effectiveLimit = limit === 0 ? safetyCap : limit
    const concurrency = Math.min(Math.max(opts.concurrency ?? 5, 1), 10)

    const root = await this._fetchRoot()

    const queue: Array<{ job: JenkinsJob; path: string[] }> = []
    const results: JenkinsJob[] = []

    for (const j of root.jobs || []) {
      const name = j.name || ""
      if (!j.fullName) j.fullName = name
      queue.push({ job: j, path: [name] })
    }

    const qLower = query.toLowerCase()
    let active = 0
    let processed = 0

    const maybeEmit = () => {
      if (opts.onBatch)
        opts.onBatch(results.slice(), {
          processed,
          queued: queue.length,
          total: results.length,
        })
    }

    return await new Promise<JenkinsJob[]>((resolve) => {
      const pump = () => {
        if (results.length >= effectiveLimit)
          return resolve(results.slice(0, effectiveLimit))
        if (queue.length === 0 && active === 0)
          return resolve(results.slice(0, effectiveLimit))
        while (
          active < concurrency &&
          queue.length > 0 &&
          results.length < effectiveLimit
        ) {
          const { job, path } = queue.shift()!
          active++
          ;(async () => {
            try {
              if (job.jobs === undefined) {
                try {
                  const data = await this._request<JenkinsJob>(
                    `job/${encodeURIComponent(job.name || "")}/api/json?tree=name,url,color,jobs[name,url,color]`,
                  )
                  if (data && data.jobs) {
                    job.jobs = data.jobs
                    for (const child of job.jobs) {
                      const cname = child.name || ""
                      const fullParts = [...path, cname]
                      if (!child.fullName)
                        child.fullName = fullParts.filter(Boolean).join("/")
                      queue.push({ job: child, path: fullParts })
                    }
                  }
                } catch {
                  /* ignore */
                }
              } else if (Array.isArray(job.jobs) && job.jobs.length) {
                for (const child of job.jobs) {
                  const cname = child.name || ""
                  const fullParts = [...path, cname]
                  if (!child.fullName)
                    child.fullName = fullParts.filter(Boolean).join("/")
                  queue.push({ job: child, path: fullParts })
                }
              }
              const fullName = job.fullName || job.name || ""
              if (!qLower || fullName.toLowerCase().includes(qLower)) {
                results.push(job)
              }
            } finally {
              processed++
              active--
              maybeEmit()
              // Throttle UI churn slightly
              setTimeout(pump, 0)
            }
          })()
        }
      }
      maybeEmit()
      pump()
    })
  }

  /**
   * Diagnose a build failure: collect failed pipeline stages, their failing
   * steps with log tails, test failures, and actionable hints.
   *
   * @param job - Job name (supports nested/multibranch paths)
   * @param build - Build number, or "lastBuild", or omitted for latest
   * @param opts - Options for log tailing and test limits
   * @returns Structured diagnosis with failed stages, tests, and hints
   */
  async diagnoseBuild(
    job: string,
    build?: number | string,
    opts: DiagnoseBuildOptions = {},
  ): Promise<DiagnoseBuildResult> {
    const { lines = 80, maxBytes = 16384, maxTests = 10, errorPatterns } = opts

    // A string ("lastBuild", "lastFailedBuild") is a Jenkins permalink and
    // goes straight into the URL; omitted means the latest build.
    const buildInfo = await this.getBuild(job, build as number | undefined)
    const buildNumber = buildInfo.number
    const result = buildInfo.result ?? null
    const url =
      buildInfo.url ??
      joinUrl(
        this.baseUrl,
        `${await this._getResolvedJobPath(job)}/${buildNumber}/`,
      )

    const hints: string[] = []
    let failedStages: FailedStage[] = []
    let tests: TestSummary | null = null

    // Try to get pipeline stages (wfapi/describe)
    let stagesData: any
    try {
      stagesData = await this.getPipelineStages(job, buildNumber)
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) {
        hints.push("no pipeline stages (not a Pipeline job)")
        stagesData = null
      } else {
        throw err
      }
    }

    if (stagesData && stagesData.stages) {
      // Walk ALL stages, not relying on order (parallel branches flatten)
      for (const stage of stagesData.stages) {
        const stageStatus = stage.status || ""
        if (stageStatus !== "FAILED" && stageStatus !== "UNSTABLE") continue

        // Get steps for this stage
        let stepsData: any
        try {
          stepsData = await this.getStageSteps(job, buildNumber, stage.id)
        } catch {
          // If we can't get steps, record stage with empty steps
          failedStages.push({
            name: stage.name || stage.id,
            status: stageStatus,
            steps: [],
          })
          continue
        }

        const stepNodes = stepsData.stageFlowNodes || []
        if (stepNodes.length === 0) {
          failedStages.push({
            name: stage.name || stage.id,
            status: stageStatus,
            steps: [],
          })
          continue
        }

        // Find first FAILED step, fall back to last step
        let failedStep = stepNodes.find((s: any) => s.status === "FAILED")
        if (!failedStep) failedStep = stepNodes[stepNodes.length - 1]

        // Fetch log tail for the failing step
        let logTail = ""
        let errorLines: ErrorBlock[] | null = null
        let logLineCount: number | null = null
        let reportLinks: string[] | null = null
        try {
          const fullLog = cleanStepLog(
            await this.getStepLog(job, buildNumber, failedStep.id),
          )
          const logLines = fullLog.split("\n")
          logLineCount = logLines.length
          errorLines = findErrorLines(fullLog, { patterns: errorPatterns })
          reportLinks = findReportLinks(fullLog)
          const tailLines = logLines.slice(-lines).join("\n")
          // Cap at maxBytes (UTF-8), keeping the END
          const encoder = new TextEncoder()
          const encoded = encoder.encode(tailLines)
          if (encoded.length > maxBytes) {
            // Find the byte boundary at maxBytes, then decode from there
            const decoder = new TextDecoder()
            // We need to keep the END, so slice from (length - maxBytes)
            const startByte = encoded.length - maxBytes
            logTail = decoder.decode(encoded.slice(startByte))
          } else {
            logTail = tailLines
          }
        } catch {
          logTail = "(log unavailable)"
        }

        failedStages.push({
          name: stage.name || stage.id,
          status: stageStatus,
          steps: [
            {
              name: failedStep.name || failedStep.id,
              status: failedStep.status || "UNKNOWN",
              logTail,
              errorLines,
              logLineCount,
              reportLinks,
            },
          ],
        })
      }

      if (failedStages.length === 0 && result === "FAILURE") {
        hints.push("no failing stage found; build result is FAILURE")
      }
    } else if (!stagesData) {
      // Non-pipeline job, hints already added
    } else {
      hints.push("no stages data returned")
    }

    // Check if build is still running
    if (buildInfo.building === true) {
      hints.push("build still running")
    }

    // Fetch test report
    try {
      const testReport = await this.getTestReport(job, buildNumber)
      if (testReport && testReport.suites) {
        const failedCases: FailedTestCase[] = []
        let totalFailed = 0
        let totalTests = 0

        for (const suite of testReport.suites) {
          for (const tc of suite.cases || []) {
            totalTests++
            const tcStatus = tc.status || ""
            if (tcStatus === "FAILED" || tcStatus === "REGRESSION") {
              totalFailed++
              if (failedCases.length < maxTests) {
                const errorDetails = tc.errorDetails || null
                const stackTrace = tc.errorStackTrace || null
                let stackHead: string | null = null
                if (stackTrace) {
                  const lines = stackTrace.split("\n")
                  stackHead = lines.slice(0, 5).join("\n")
                }
                failedCases.push({
                  name: `${tc.className}.${tc.name}`,
                  error: errorDetails,
                  stackHead,
                })
              }
            }
          }
        }

        // If failCount is present, prefer it
        if (typeof testReport.failCount === "number") {
          totalFailed = testReport.failCount
        }
        if (typeof testReport.totalCount === "number") {
          totalTests = testReport.totalCount
        } else if (
          typeof testReport.failCount === "number" &&
          typeof testReport.passCount === "number" &&
          typeof testReport.skipCount === "number"
        ) {
          totalTests =
            testReport.failCount + testReport.passCount + testReport.skipCount
        }

        tests = {
          failed: totalFailed,
          total: totalTests,
          first: failedCases,
        }
      }
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) {
        tests = null
      } else {
        // Other errors propagate
        throw err
      }
    }

    return {
      job,
      build: buildNumber,
      result,
      url,
      failedStages,
      tests,
      hints,
    }
  }

  // ── Job lifecycle ──────────────────────────────────────────────────────────

  async getJobConfig(
    job: string,
  ): Promise<{ jobName: string; config: string }> {
    const config = await this._requestWithPathResolution(
      job,
      "/config.xml",
      (path) => this._request<string>(path),
    )
    return { jobName: job, config: String(config) }
  }

  async createJob(
    job: string,
    configXml: string,
  ): Promise<{ jobName: string; created: true }> {
    const { parent, name } = splitItemName(job)
    const suffix = `/createItem?name=${encodeURIComponent(name)}`
    const post = (path: string) =>
      this._post(path, { body: configXml, contentType: "application/xml" })
    if (parent) await this._requestWithPathResolution(parent, suffix, post)
    else await post(suffix)
    return { jobName: job, created: true }
  }

  // `from` carries a leading slash on purpose: Jenkins resolves it relative to
  // the new item's parent folder otherwise, so a copy across folders silently
  // finds the wrong source, or none. The slash forces lookup from the root.
  async copyJob(
    fromName: string,
    newName: string,
  ): Promise<{ fromName: string; newName: string; copied: true }> {
    const source = fromName.split("/").filter(Boolean).join("/")
    if (!source)
      throw new Error("Job name must be a non-empty Jenkins full name")
    const { parent, name } = splitItemName(newName)
    const suffix =
      `/createItem?name=${encodeURIComponent(name)}` +
      `&mode=copy&from=${encodeURIComponent(`/${source}`)}`
    const post = (path: string) => this._post(path)
    if (parent) await this._requestWithPathResolution(parent, suffix, post)
    else await post(suffix)
    return { fromName, newName, copied: true }
  }

  async updateJobConfig(
    job: string,
    configXml: string,
  ): Promise<{ jobName: string; updated: true }> {
    await this._requestWithPathResolution(job, "/config.xml", (path) =>
      this._post(path, { body: configXml, contentType: "application/xml" }),
    )
    return { jobName: job, updated: true }
  }

  // confirmRename is the POST endpoint behind the rename form; `rename` alone
  // is the GET page, which a POST renders with a 200 and renames nothing.
  async renameJob(
    job: string,
    newName: string,
  ): Promise<{ oldName: string; newName: string; renamed: true }> {
    await this._requestWithPathResolution(
      job,
      `/confirmRename?newName=${encodeURIComponent(newName)}`,
      (path) => this._post(path),
    )
    this._resolvedPathCache.delete(job)
    return { oldName: job, newName, renamed: true }
  }

  async deleteJob(job: string): Promise<{ jobName: string; deleted: true }> {
    await this._requestWithPathResolution(job, "/doDelete", (path) =>
      this._post(path),
    )
    this._resolvedPathCache.delete(job)
    return { jobName: job, deleted: true }
  }

  async enableJob(job: string): Promise<{ jobName: string; enabled: true }> {
    await this._requestWithPathResolution(job, "/enable", (path) =>
      this._post(path),
    )
    return { jobName: job, enabled: true }
  }

  async disableJob(job: string): Promise<{ jobName: string; disabled: true }> {
    await this._requestWithPathResolution(job, "/disable", (path) =>
      this._post(path),
    )
    return { jobName: job, disabled: true }
  }

  // ── Builds ─────────────────────────────────────────────────────────────────

  async deleteBuild(
    job: string,
    buildNumber: number,
  ): Promise<{ jobName: string; buildNumber: number; deleted: true }> {
    await this._requestWithPathResolution(
      job,
      `/${buildNumber}/doDelete`,
      (path) => this._post(path),
    )
    return { jobName: job, buildNumber, deleted: true }
  }

  // ⚠ The redirect is not followed. A followed 3xx turns an authentication
  // bounce into a 200 HTML page that reads as a queued replay, so a 3xx is an
  // error and success is a 2xx carrying the queue item's Location.
  async replayBuild(
    job: string,
    buildNumber: number,
    mainScript?: string,
  ): Promise<{ jobName: string; buildNumber: number; queueUrl: string }> {
    const res = await this._requestWithPathResolution(
      job,
      `/${buildNumber}/replay/rebuild`,
      (path) =>
        this._post(
          path,
          mainScript === undefined
            ? { redirect: "manual" }
            : {
                redirect: "manual",
                contentType: "application/x-www-form-urlencoded",
                body: new URLSearchParams({ mainScript }).toString(),
              },
        ),
    )
    const location = res.headers.get("location")
    if (res.status >= 300 || res.type === "opaqueredirect")
      throw new Error(
        `Replay failed: HTTP ${res.status}` +
          (location ? `, redirects to ${location}, not followed` : ""),
      )
    if (!location)
      throw new Error(
        `Replay returned HTTP ${res.status} without a queue Location header`,
      )
    return { jobName: job, buildNumber, queueUrl: location }
  }

  // ── Nodes ──────────────────────────────────────────────────────────────────

  async listNodes(): Promise<JenkinsNode[]> {
    const data = await this._request<any>("computer/api/json?depth=1")
    return (data?.computer || []).map((node: any) => {
      const numExecutors = node.numExecutors || 0
      const executors = Array.isArray(node.executors) ? node.executors : null
      return {
        name: node.displayName || "",
        offline: node.offline || false,
        idle: node.idle || false,
        numExecutors,
        busyExecutors: executors
          ? executors.filter((e: any) => e && e.idle === false).length
          : node.idle
            ? 0
            : numExecutors,
        temporarilyOffline: node.temporarilyOffline || false,
        offlineCauseReason: node.offlineCauseReason || "",
      }
    })
  }

  async getNode(nodeName: string): Promise<JenkinsNodeDetail> {
    const data = await this._request<any>(
      `computer/${encodeURIComponent(nodeName)}/api/json?depth=1`,
    )
    return {
      name: data.displayName || nodeName,
      offline: data.offline || false,
      temporarilyOffline: data.temporarilyOffline || false,
      offlineCauseReason: data.offlineCauseReason || "",
      idle: data.idle || false,
      numExecutors: data.numExecutors || 0,
      assignedLabels: (data.assignedLabels || []).map((l: any) => l.name),
      monitorData: data.monitorData || {},
    }
  }

  async toggleNodeOffline(
    nodeName: string,
    offlineMessage = "",
  ): Promise<{ nodeName: string; toggledOffline: true }> {
    await this._post(
      `computer/${encodeURIComponent(nodeName)}/toggleOffline?offlineMessage=${encodeURIComponent(offlineMessage)}`,
    )
    return { nodeName, toggledOffline: true }
  }

  // ── Views ──────────────────────────────────────────────────────────────────

  async listViews(): Promise<JenkinsView[]> {
    const data = await this.tree<any>(
      "api/json",
      "views[name,url,jobs[name,url]]",
    )
    if (!Array.isArray(data?.views)) return []
    return data.views.map((v: any) => ({
      name: v.name || "",
      url: v.url || "",
      jobs: (v.jobs || []).map((j: any) => ({ name: j.name, url: j.url })),
    }))
  }

  async getView(viewName: string): Promise<JenkinsViewDetail> {
    const data = await this._request<any>(
      `view/${encodeURIComponent(viewName)}/api/json`,
    )
    return {
      name: data.name || viewName,
      url: data.url || "",
      description: data.description || "",
      jobs: (data.jobs || []).map((j: any) => ({
        name: j.name,
        url: j.url,
        color: j.color,
      })),
    }
  }

  // ── System ─────────────────────────────────────────────────────────────────

  async getSystemInfo(): Promise<JenkinsSystemInfo> {
    const data = await this.tree<any>(
      "api/json",
      "nodeDescription,nodeName,numExecutors,mode,quietingDown,useCrumbs,useSecurity",
    )
    return {
      nodeDescription: data.nodeDescription || "",
      nodeName: data.nodeName || "",
      numExecutors: data.numExecutors || 0,
      mode: data.mode || "",
      quietingDown: data.quietingDown || false,
      useCrumbs: data.useCrumbs || false,
      useSecurity: data.useSecurity || false,
    }
  }

  // Jenkins reports its version only in the X-Jenkins response header.
  async getVersion(): Promise<{ version: string }> {
    const url = joinUrl(this.baseUrl, "api/json")
    let res: Response
    try {
      res = await this._fetchWithTimeout(url, {
        method: "HEAD",
        headers: { ...this.authHeaders },
      })
    } catch (e) {
      throw new HttpError(0, `Request failed ${url}: ${(e as Error).message}`)
    }
    if (!res.ok)
      throw new HttpError(res.status, `HTTP ${res.status} ${res.statusText}`)
    return { version: res.headers.get("x-jenkins") || "unknown" }
  }

  async getPlugins(): Promise<JenkinsPlugin[]> {
    const data = await this.tree<any>(
      "pluginManager/api/json",
      "plugins[shortName,longName,version,enabled,active,hasUpdate]",
    )
    return (data?.plugins || []).map((p: any) => ({
      shortName: p.shortName || "",
      longName: p.longName || "",
      version: p.version || "",
      enabled: p.enabled || false,
      active: p.active || false,
      hasUpdate: p.hasUpdate || false,
    }))
  }

  async quietDown(reason = ""): Promise<{ quietingDown: true }> {
    await this._post(
      reason ? `quietDown?reason=${encodeURIComponent(reason)}` : "quietDown",
    )
    return { quietingDown: true }
  }

  async cancelQuietDown(): Promise<{ quietingDown: false }> {
    await this._post("cancelQuietDown")
    return { quietingDown: false }
  }

  async safeRestart(): Promise<{ restarting: true }> {
    await this._post("safeRestart")
    return { restarting: true }
  }
}
