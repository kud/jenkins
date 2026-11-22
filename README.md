<div align="center">

![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-339933?style=flat-square&logo=node.js&logoColor=white)
![npm](https://img.shields.io/npm/v/@kud/jenkins?style=flat-square&color=CB3837)
![MIT](https://img.shields.io/badge/licence-MIT-22C55E?style=flat-square)

**Headless Jenkins core — client, config, and types (data · actions · auth).**

[Features](#-features) • [Quick Start](#-quick-start) • [API Reference](#-api-reference) • [Development](#-development)

</div>

## 🌟 Features

- 🧩 **Single client, full surface** — `JenkinsClient` covers job/build metadata, console logs (with live streaming), failure diagnosis, artifacts, the build queue, triggers, and job/node/view/system administration
- ⚙️ **Layered config resolution** — stored server profile, overridden by instances declared in the environment, overridden by per-call overrides, so callers never hardcode credentials
- 🗂 **Multi-server profiles** — add, switch, and remove named Jenkins servers without touching env vars
- 🔁 **Resilient HTTP layer** — per-request timeout (15 s by default), opt-in bounded retry with backoff for reads on network errors, timeouts and 5xx responses (writes never retry), automatic CSRF crumb handling on every mutating call
- 🌲 **Recursive job search** — BFS traversal across nested folders, plus an incremental/concurrent variant with progress callbacks for large instances
- 🧼 **Log sanitisation** — strips ANSI escape codes and control characters from console output for clean rendering
- 📐 **Fully typed** — exported TypeScript types for jobs, builds, artifacts, parameters, and changesets

Surface-agnostic by design: this package holds no CLI, no prompts, no rendering — just data, actions, and auth. [`@kud/jenkins-cli`](https://github.com/kud/jenkins-cli) is the command surface and interactive TUI built on top of it.

## 🚀 Quick Start

```sh
npm install @kud/jenkins
```

```ts
import { JenkinsClient, resolveConfig } from "@kud/jenkins"

const cfg = resolveConfig()
const client = new JenkinsClient(cfg.url, cfg.user, cfg.token)

const jobs = await client.searchJobs("my-service")
const build = await client.getBuild("my-service")

console.log(build.result, build.building)
```

Configuration resolves in layers, from lowest to highest priority: a stored server profile, then instances declared in the environment (which win over the stored file when present), then `JENKINS_SERVER` / `JENKINS_TIMEOUT` / `JENKINS_RETRIES`, then explicit overrides. The resolved `timeout` and `retries` are not applied for you; pass them to the client's options (`new JenkinsClient(url, user, token, { timeout, retries })`).

```sh
export JENKINS_URL=https://ci.example.com
export JENKINS_USER=erwann
export JENKINS_API_TOKEN=xxxxxxxxxxxx
```

Several instances can be declared at once, comma or pipe separated and matched
positionally. `JENKINS_INSTANCES` names them; without it, each name is derived
from its URL's first hostname label. The first instance is the default, and
`JENKINS_SERVER` (or a `server` override) selects another:

```sh
export JENKINS_INSTANCES=pipeline,scheduler
export JENKINS_URL=https://pipeline.example.com,https://scheduler.example.com
export JENKINS_USER=erwann          # a single value applies to every instance
export JENKINS_API_TOKEN=tok1,tok2
```

A name/URL count mismatch is an error rather than a best-effort pairing: a short
list would silently authenticate one instance with another's credentials.

Or manage named servers on disk (`~/.config/jenkins-cli/config.json`, override the base with `XDG_CONFIG_HOME`):

```ts
import { addServer, useServer, listServers } from "@kud/jenkins"

addServer("prod", {
  url: "https://ci.example.com",
  user: "erwann",
  token: "xxxx",
})
useServer("prod")
listServers() // [{ name: "prod", url: "…", user: "erwann", token: "…", current: true }]
```

## 📖 API Reference

### Jobs & Builds

| Method                                    | Description                                                                                       |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `getJob(job)`                             | Fetch a job's metadata (depth 1)                                                                  |
| `getBuild(job, buildNumber?)`             | Fetch a build; defaults to the last build                                                         |
| `listBuilds(job, limit?)`                 | Fetch recent builds concurrently                                                                  |
| `getBuildChanges(job, buildNumber?)`      | Trigger cause, culprits, and SCM commits for a build                                              |
| `getJobParameters(job)`                   | Parameter definitions for a parameterised job                                                     |
| `listJobs()`                              | Top-level jobs (no folder recursion)                                                              |
| `searchJobs(query, limit?)`               | Recursive BFS search across folders                                                               |
| `searchJobsIncremental(query, opts?)`     | Same search, with a progress callback and bounded concurrency                                     |
| `getSpecificJobs(jobNames)`               | Batch-fetch jobs by name, tolerant of per-job errors                                              |
| `getPipelineStages(job, buildNumber)`     | Pipeline stage breakdown (Workflow API)                                                           |
| `getStageSteps(job, buildNumber, nodeId)` | Steps of one pipeline stage                                                                       |
| `getStepLog(job, buildNumber, stepId)`    | Log of one pipeline step                                                                          |
| `getTestReport(job, buildNumber)`         | Test report for a build                                                                           |
| `diagnoseBuild(job, buildNumber?, opts?)` | Diagnose a failed build: failed stages, steps with log tails, test failures, hints                |
| `resolveJobPath(job)`                     | REST path for a job, keeping a multibranch branch's slashes in one segment (for `tree()` callers) |

### Logs

| Method                                                         | Description                                     |
| -------------------------------------------------------------- | ----------------------------------------------- |
| `getConsoleText(job, buildNumber?)`                            | Full console output as text                     |
| `streamConsole(job, buildNumber, onChunk, intervalMs?, opts?)` | Poll and stream console output as it's produced |

### Artifacts

| Method                                             | Description                        |
| -------------------------------------------------- | ---------------------------------- |
| `getArtifacts(job, buildNumber?)`                  | Build plus its artifact list       |
| `downloadArtifact(job, buildNumber, relativePath)` | Download an artifact as a `Buffer` |

### Actions

| Method                                    | Description                   |
| ----------------------------------------- | ----------------------------- |
| `triggerBuild(job)`                       | Trigger a build               |
| `triggerBuildWithParameters(job, params)` | Trigger a parameterised build |
| `stopBuild(job, buildNumber)`             | Stop a running build          |
| `getQueue()`                              | Fetch the build queue         |
| `cancelQueueItem(id)`                     | Cancel a queued item          |

### Job lifecycle & admin

| Area   | Methods                                                                                                        |
| ------ | -------------------------------------------------------------------------------------------------------------- |
| Jobs   | `getJobConfig`, `createJob`, `copyJob`, `updateJobConfig`, `renameJob`, `deleteJob`, `enableJob`, `disableJob` |
| Builds | `deleteBuild(job, buildNumber)`, `replayBuild(job, buildNumber, mainScript?)`                                  |
| Nodes  | `listNodes()`, `getNode(name)`, `toggleNodeOffline(name, message?)`                                            |
| Views  | `listViews()`, `getView(name)`                                                                                 |
| System | `getSystemInfo()`, `getVersion()`, `getPlugins()`, `quietDown(reason?)`, `cancelQuietDown()`, `safeRestart()`  |

### Config

| Export                                  | Description                                                                          |
| --------------------------------------- | ------------------------------------------------------------------------------------ |
| `resolveConfig(overrides?)`             | Layered resolution: stored profile → env instances → env settings → overrides        |
| `envInstances()` / `listInstances()`    | Instances declared in the environment / env plus stored servers, env winning by name |
| `addServer(name, { url, user, token })` | Add or update a named server profile                                                 |
| `useServer(name)`                       | Switch the active named server                                                       |
| `removeServer(name)`                    | Remove a named server profile                                                        |
| `listServers()`                         | List all named servers, with the active one flagged                                  |
| `writeSecretFile(path, data)`           | Write a credentials file `0600`, atomically, in a `0700` directory (used by every save) |

### Utilities

| Export                                 | Description                                                                                   |
| -------------------------------------- | --------------------------------------------------------------------------------------------- |
| `sanitizeLogChunk(chunk, opts?)`       | Strip ANSI codes and control characters from console output (`sanitizeAndAppend` for streams) |
| `sanitizeForTerminal(text, opts?)`     | Make untrusted text safe to print: removes every escape (CSI, OSC, 8-bit C1), control and CR; `{ preserveColors: true }` keeps SGR colours only. `getConsoleText` returns raw text, so printing callers apply this |
| `findErrorLines(log, opts?)`           | Error lines with context, as used by `diagnoseBuild`; also `findReportLinks`, `cleanStepLog`  |
| `buildStatusToken(build)`              | Map a build to `success`, `failure`, `unstable`, `aborted`, `running` or `unknown`            |
| `fmtDuration(build)` / `fmtAge(build)` | Compact duration (`3m`) and age (`12m ago`)                                                   |
| `normalizeUrl(url)`                    | Fix malformed schemes such as `http:/host` → `http://host`                                    |
| `ensureScheme(url)`                    | Prefix `https://` onto a bare host if no scheme is present                                    |
| `parseBuildSpecifier(input)`           | Parse a job name, job URL, or build URL into a structured descriptor                          |

### Types

`JenkinsJob`, `JenkinsBuild`, `JenkinsBuildRef`, `JenkinsArtifact`, `JenkinsCrumb`, `JenkinsParameterDefinition`, `JenkinsCommit`, `JenkinsBuildChanges`, `DiagnoseBuildResult`, `JenkinsNode`, `JenkinsView`, `JenkinsPlugin` and more — exported from `src/types.ts` and used across every method above.

Auth is HTTP Basic (username + API token), or a bearer token with `new JenkinsClient(url, "", "", { auth: { bearer: token } })`; with neither, no `Authorization` header is sent. Every mutating call (`triggerBuild`, `stopBuild`, `cancelQueueItem`, …) attaches a CSRF crumb and the session cookie it was issued with, and re-issues both once if Jenkins expires the session (a 403), so callers never manage crumbs themselves.

Every caller-supplied piece of a URL path is confined to its own segment, and a bad one throws `JenkinsInputError` before any request leaves: a build is a positive integer or a permalink (`lastBuild`, `lastSuccessfulBuild`, `lastFailedBuild`, `lastStableBuild`, `lastUnstableBuild`, `lastCompletedBuild`), a queue id an integer, job, node and view names may not contain `.` or `..` segments, and an artifact path may not contain empty, `.` or `..` segments. A client given credentials and a plain `http://` URL (other than loopback) emits one `JENKINS_INSECURE_TRANSPORT` process warning.

## 🔧 Development

```
src/
├── index.ts             # public exports
├── jenkins-client.ts    # JenkinsClient — data + actions
├── config.ts            # resolveConfig, env instances, named-server helpers
├── types.ts             # shared Jenkins types
├── url-utils.ts         # URL parsing/normalisation helpers
├── formatters.ts        # build status token, duration and age
├── error-lines.ts       # error-line extraction for diagnosis
├── path-segments.ts     # URL path-segment guards (JenkinsInputError)
└── log-sanitizer.ts     # sanitizeLogChunk, sanitizeAndAppend, sanitizeForTerminal
```

| Script      | Description                          |
| ----------- | ------------------------------------ |
| `build`     | Compile `src/` to `dist/` via `tsc`  |
| `typecheck` | Type-check without emitting output   |
| `test`      | Run `test/` with `node --test` + tsx |

```sh
git clone https://github.com/kud/jenkins.git
cd jenkins
npm install
npm run build
```

## 🏗 Tech Stack

| Layer        | Choice                                                               |
| ------------ | -------------------------------------------------------------------- |
| Language     | TypeScript 5.9                                                       |
| Runtime      | Node.js ≥ 22, native `fetch`                                         |
| Module       | ESM (`type: module`)                                                 |
| Dependencies | None at runtime — `@types/node`, `tsx` and `typescript` are dev-only |

---

MIT © [kud](https://github.com/kud) — Made with ❤️
