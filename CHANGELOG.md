# Changelog

All notable changes to this project are documented here.

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
