# Changelog

All notable changes to this project are documented here.

---

## 2.1.0 — 2026-08-18

### Highlights

- **New public `tree(path, tree?)` method** — query any Jenkins remote-access endpoint with a `tree` filter you choose, instead of the fixed one baked into every other method. Fields like `healthReport`, `_class`, or `lastBuild[actions[causes[*]]]` — the only way to learn what actually triggered a build — were previously out of reach unless you hand-rolled a second HTTP client alongside this one and re-implemented auth, retries and crumb handling just to fetch one extra field. ([fc21de1](https://github.com/kud/jenkins/commit/fc21de13d51735b49be1483a71a673ab93c88b0a))

### Fixes

- **Stray slashes in a job name no longer produce a false "job not found".** A leading, trailing, or doubled slash — ordinary input when job names come from config files, CLI arguments, or API responses — used to build a path like `job//job/...`, which Jenkins answers with a 404 indistinguishable from the job genuinely not existing. Empty path segments are now dropped before the request goes out. `jobPath` also gained its first test coverage, despite being exported and relied on by nearly every method. ([538d7a5](https://github.com/kud/jenkins/commit/538d7a5821d775b0f9b3fefd52fc70799a84055e))

<details>
<summary>Internal (2 commits)</summary>

- Tightened the environment-instances test to assert by inclusion rather than exact match, and enabled npm provenance on publish.

</details>

---
