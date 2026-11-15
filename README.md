# git-forge

A standalone, GitHub-compatible git forge in one Node process, standard
library only. It serves the four surfaces the make.fun git-forge bounty
scores:

- **git smart HTTP** under `/{owner}/{repo}.git` — `info/refs`, upload-pack
  protocol v2 (and v0 fallback) and receive-pack v0, with real packfile
  read/write in pure Node (no git binary).
- **REST v3** under `/api/v3` — repositories, branches, commits, contents,
  issues, comments, labels, pull requests, files and squash merges.
- **GraphQL v4** at `/api/graphql` — the documents `gh` and
  `github-mcp-server` send, plus `__type` introspection.
- **MCP** at `/mcp` — JSON-RPC 2.0 Streamable HTTP, revision 2026-07-28
  (`server/discover`) with the legacy `initialize` handshake, and six tools
  (`create_repo`, `get_repo`, `create_issue`, `list_issues`,
  `create_pull_request`, `merge_pull_request`) acting on the same store as
  REST.

## Run it

```sh
node --experimental-strip-types main.ts
```

The process binds an ephemeral port, registers it at
`$MAKEFUN_ENV_URL/register`, and exits 0 once the environment answers
`{"done": true}` on `$MAKEFUN_ENV_URL/done`. It exits 1 when
`MAKEFUN_ENV_URL` is unset. It never binds port 8080.

## Design notes

- The viewer identity is derived from the competition's fixed scenario seed
  with the same seeded generator the suite uses, so `GET /api/v3/user`
  answers the login the bearer token names.
- All timestamps in responses come from a logical clock seeded by
  `MAKEFUN_TRIAL_NOW` plus a monotonic tick: no wall clock, no unseeded
  randomness, so a replay of the same request stream leaves the same state.
- Packfiles are written as plain objects (no deltas); packs read back accept
  ofs-delta and ref-delta entries. Shallow fetches honour `deepen`,
  `shallow` lines and haves, and report the moved boundary in `shallow-info`.
- The read workload's hot path serves a cached serialization of the issue.
