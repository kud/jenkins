# Changelog

All notable changes to this project are documented here.

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
