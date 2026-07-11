# @kud/jenkins

Headless Jenkins core — the surface-agnostic logic layer behind
[`@kud/jenkins-cli`](https://github.com/kud/jenkins-cli). Data, actions, auth,
and types, with no presentation.

```sh
npm install @kud/jenkins
```

```ts
import { JenkinsClient, resolveConfig } from "@kud/jenkins"

const cfg = resolveConfig()
const client = new JenkinsClient(cfg.url, cfg.user, cfg.token)
const jobs = await client.searchJobs("")
```

## Exports

- `JenkinsClient` — data fetching + build actions (status, builds, console,
  streaming, artifacts, queue, triggers).
- `resolveConfig`, `addServer`, `useServer`, `removeServer`, `listServers` —
  layered config (XDG file → env → named servers).
- Types — `JenkinsJob`, `JenkinsBuild`, and friends.
- `sanitizeLogChunk`, URL helpers — log/URL utilities.

## Surfaces over this core

| Package            | Role                              |
| ------------------ | --------------------------------- |
| `@kud/jenkins-cli` | command surface + interactive TUI |

## License

MIT © Erwann Mest
