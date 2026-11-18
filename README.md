# coreforge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone, GitHub-compatible git forge in a single Node process,
standard library only. It serves four surfaces from one in-memory
store:

- **Git smart HTTP** at `/{owner}/{repo}.git` — upload-pack protocol
  v2 (`ls-refs`, `fetch` with shallow/deepen and partial-clone
  filters) with a v0 fallback, and receive-pack v0 with
  report-status, side-band-64k and delete-refs. Fast-forward only.
- **REST v3** under `/api/v3` — repositories, branches, commits,
  contents, labels, issues, comments and pull requests (with squash
  merges), GitHub-shaped JSON throughout.
- **GraphQL v4** at `/api/graphql` — the documents gh and
  github-mcp-server send: viewer, repository fields, issue and
  pull-request reads, cursor pagination, the create/close/merge
  mutations, and `__type` introspection.
- **MCP** at `/mcp` — JSON-RPC over streamable HTTP, the 2026-07-28
  `server/discover` revision plus the earlier initialize handshake,
  with six tools that act on the same store as REST.

Everything is deterministic: timestamps derive from
`MAKEFUN_TRIAL_NOW` plus a counter, ids from counters, and no
request path reads the wall clock or a random source, so a replayed
trial answers byte for byte as the live one did.

## Run it

```sh
node main.ts
```

The process binds an ephemeral port, registers it with the contest
environment at `$MAKEFUN_ENV_URL/register`, serves until the
environment answers `{"done": true}` at `$MAKEFUN_ENV_URL/done`,
and exits 0. The bearer token the suite presents is read from
`$MAKEFUN_SHOP_TOKEN`.

## Layout

- `main.ts` — the entry ↔ env lifecycle (from the contest starter).
- `app.ts` — routing.
- `store.ts` — forge state: users, repositories, issues, pulls.
- `git.ts` — the git object model: objects, trees, commits, packs.
- `gitproto.ts` — the smart-HTTP wire protocol.
- `rest.ts` — the REST v3 surface.
- `graphql.ts` — a small GraphQL engine and the v4 schema.
- `mcp.ts` — the MCP endpoint.

---

<sub>Entered on [make.fun](https://make.fun/?ref=e3jafkpj&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
