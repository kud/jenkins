# Changelog

All notable changes to this project are documented here.

---

## 2.7.1 — 2026-11-10

### Fixes

- **Nested folders are now found.** Folders more than one level deep were requested by bare name at the root and missed; they now resolve from their full path. ([798773f](https://github.com/kud/jenkins/commit/798773fe60306604139be3292c0b574ab5f2a8ff))

### Documentation

- **User docs for the client.** New pages cover configuration, `JenkinsClient` and auth, logs, artefacts and queue, job lifecycle and admin, errors and retries, and utilities. ([4e786dc](https://github.com/kud/jenkins/commit/4e786dc6b7dc2e9ea27d1bb7d5d90fdf6ba1d2e9))

---

## 2.7.0 — 2026-11-10

### Highlights

- **Bearer token auth.** Pass `auth: { bearer }` to the `JenkinsClient` constructor to authenticate with a Bearer token; it takes precedence over user and token Basic auth. ([b82defe](https://github.com/kud/jenkins/commit/b82defed723f2cc1f6bb3e2f2e32f5ae5e210300))
- **`resolveJobPath(job)` is now public.** It turns multibranch job names containing slashes into the right path, caches the result, and is documented in the README. ([b82defe](https://github.com/kud/jenkins/commit/b82defed723f2cc1f6bb3e2f2e32f5ae5e210300))

### Fixes

- **Writes survive an expired session.** The CSRF crumb is now tied to its session cookie, and every write, Bearer included, re-issues it once on a 403 instead of failing. ([b82defe](https://github.com/kud/jenkins/commit/b82defed723f2cc1f6bb3e2f2e32f5ae5e210300))

---

## 2.6.0 — 2026-11-10

### Highlights

- **Manage job lifecycle from `JenkinsClient`.** New `getJobConfig`, `createJob`, `copyJob`, `updateJobConfig`, `renameJob`, `deleteJob`, `enableJob` and `disableJob` cover everything short of the Jenkins UI. ([12164d9](https://github.com/kud/jenkins/commit/12164d94234f3d1e611930a3b75623b3e5d19cb6))
- **Build clean-up and replay.** `deleteBuild` and `replayBuild` let you prune or re-run a pipeline build without leaving code. ([12164d9](https://github.com/kud/jenkins/commit/12164d94234f3d1e611930a3b75623b3e5d19cb6))
- **Inspect and administer the controller.** Nodes (`listNodes`, `getNode`, `toggleNodeOffline`), views (`listViews`, `getView`), system details (`getSystemInfo`, `getVersion`, `getPlugins`) and maintenance (`quietDown`, `cancelQuietDown`, `safeRestart`). ([12164d9](https://github.com/kud/jenkins/commit/12164d94234f3d1e611930a3b75623b3e5d19cb6))
- **Multibranch-aware and safe by default.** Job-scoped calls resolve multibranch paths, and write calls never retry, so a flaky connection cannot create or delete something twice. ([12164d9](https://github.com/kud/jenkins/commit/12164d94234f3d1e611930a3b75623b3e5d19cb6))

---

## 2.5.0 — 2026-11-09

### Highlights

- **Coloured test-runner errors are now found.** `diagnoseBuild` strips ANSI escapes and bare colour codes such as `[31m` from each failing step's log before matching, so a red `Error:` is no longer missed and the tail reads as plain text. `cleanStepLog` is exported. ([a6fb33e](https://github.com/kud/jenkins/commit/a6fb33e9ed9032cd9dc85230f822113c72d020b7))
- **Two more default error patterns:** `FAIL` at line start and `Failed Tests N` (N ≥ 1), as printed by common JS test runners. ([a6fb33e](https://github.com/kud/jenkins/commit/a6fb33e9ed9032cd9dc85230f822113c72d020b7))

---

## 2.4.0 — 2026-11-09

### Highlights

- **Test-runner failures are now caught as error lines.** The default patterns match `Some tests failed` and `N failed` (N ≥ 1) at line start, so steps that run tests remotely and print only a summary no longer come back empty. ([fcdaa2f](https://github.com/kud/jenkins/commit/fcdaa2fffe364940f0ce31061af3f5e1c9221b14))
- **Failing steps gain `reportLinks`**, the URLs printed as `Report Link: …` or `report: …`, deduplicated and in order, or `null` when there is no log. `findReportLinks` is exported. ([fcdaa2f](https://github.com/kud/jenkins/commit/fcdaa2fffe364940f0ce31061af3f5e1c9221b14))

---

## 2.3.0 — 2026-11-09

### Highlights

- **`diagnoseBuild` now shows the real error even when the log tail is upload noise.** Each failing step gains `errorLines` (matches with two lines of context, last five blocks, 4 KB cap) and `logLineCount`; `errorLines` is `[]` when nothing matched and `null` when there is no log. ([c973c1c](https://github.com/kud/jenkins/commit/c973c1c66a75f154808258ce6a75551ebd5a88df))
- **New `errorPatterns` option** replaces the conservative defaults (`Error:`, `failed:`, `✘`, `FAILED` at line start), and `findErrorLines` and `DEFAULT_ERROR_PATTERNS` are now exported. ([c973c1c](https://github.com/kud/jenkins/commit/c973c1c66a75f154808258ce6a75551ebd5a88df))

<details>
<summary>Internal (2 commits)</summary>

- Config tests no longer race on CI runners that set `XDG_CONFIG_HOME`, and the error-line tests use realistic failure fixtures. ([8054624](https://github.com/kud/jenkins/commit/805462459ccf3791f523c86562aa83a5fe9fa280), [7385075](https://github.com/kud/jenkins/commit/7385075f39c90f4aa1d76faecf978dcc156a35cd))

</details>

---

## 2.2.0 — 2026-11-09

### Highlights

- **New `JenkinsClient.diagnoseBuild(job, build?, opts)`** returns the failed stages with the failing step's log tail (80 lines or 16 KB by default), the first failed tests and hints, so a red build can be understood in one call. ([1e21b4a](https://github.com/kud/jenkins/commit/1e21b4ae94a8f6f3b2e6de1208a7abd77f7fdc10))
- **Multibranch branch names containing `/` now resolve**, such as `acme/api-gateway/feature/login`. On a 404 the client walks the folder hierarchy and caches the result. ([1e21b4a](https://github.com/kud/jenkins/commit/1e21b4ae94a8f6f3b2e6de1208a7abd77f7fdc10))

---

## 2.1.0 — 2026-08-18

### Highlights

- **New public `tree(path, tree?)` method** — query any Jenkins remote-access endpoint with a `tree` filter you choose, instead of the fixed one baked into every other method. Fields like `healthReport`, `_class`, or `lastBuild[actions[causes[*]]]` — the only way to learn what actually triggered a build — were previously out of reach unless you hand-rolled a second HTTP client alongside this one and re-implemented auth, retries and crumb handling just to fetch one extra field. ([fc21de1](https://github.com/kud/jenkins/commit/fc21de13d51735b49be1483a71a673ab93c88b0a))

### Fixes

- **Stray slashes in a job name no longer produce a false "job not found".** A leading, trailing, or doubled slash — ordinary input when job names come from config files, CLI arguments, or API responses — used to build a path like `job//job/...`, which Jenkins answers with a 404 indistinguishable from the job genuinely not existing. Empty path segments are now dropped before the request goes out. `jobPath` also gained its first test coverage, despite being exported and relied on by nearly every method. ([538d7a5](https://github.com/kud/jenkins/commit/538d7a5821d775b0f9b3fefd52fc70799a84055e))

- **An anonymous Jenkins is now genuinely anonymous.** `user` and `token` are optional, and leaving them out sends no `Authorization` header at all. The Basic header used to be built unconditionally, so a client with no credentials still presented one — well formed, and authenticating as nobody — which a server answers with a 401 or records as a login attempt nobody made. Neither of those reads as "no credentials were configured". Existing three-argument callers are unaffected. ([f30cdfd](https://github.com/kud/jenkins/commit/f30cdfda9cbc0a46ec2da7243fa005d4c69bd8ae))

<details>
<summary>Internal (2 commits)</summary>

- Tightened the environment-instances test to assert by inclusion rather than exact match, and enabled npm provenance on publish.

</details>

---
