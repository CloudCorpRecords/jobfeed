# BUILD REPORT — jobfeed

Rebuild of `com.getfairquery/company-jobs-feed-mcp` v1.1.18 (remote-only, keyless capture)
as `@reneturcios/jobfeed` 0.1.0 / `io.github.CloudCorpRecords/jobfeed`.

## Fixture conflicts

**None.** The brief, the spec prose, and the fixture agree on all 7 tool
names and every required field. Required fields as served, taken from
the fixture (`harness/fixtures/fairquery-jobs-tools-original.json`):

- `jobs_get_board` — required: `ats`, `slug`
- `jobs_find_board` — required: `company`
- `jobs_check_open` — required: (absent)
- `jobs_get_job` — required: (absent)
- `jobs_list_seed_boards` — required: (absent)
- `jobs_search_by_location` — required: (absent)
- `jobs_search_companies` — required: (absent)

The fixture's tool literals (name, title, description, inputSchema —
including every property description, enum, pattern and bound) are
served verbatim from `src/forward.ts`; the `TOOL_DEFS` array was
generated programmatically from the fixture JSON to eliminate
transcription error, and was verified by the registration-integrity
test and the parity harness. The capture's `annotations` and
`outputSchema` blocks are not reproduced, per the spec
(parity compares inputSchema).

## What was built

All 19 factory files under `builds/jobfeed/`:

- `package.json` (`@reneturcios/jobfeed` 0.1.0, bin
  `jobfeed` → `dist/cli.js`, deps exactly `@modelcontextprotocol/sdk ^1`
  + `zod ^3`; devDeps `@types/node ^20`, `tsx ^4`, `typescript ^5`)
- `server.json` (description exactly the prescribed 97-char string
  "Live job-board reads across Greenhouse, Lever, Ashby and more: boards, openings, jobs, locations.";
  npm entry carries `"version": "0.1.0"`; OCI entry
  `ghcr.io/cloudcorprecords/jobfeed:0.1.0` carries **no** version field)
- `Dockerfile` (node:20-alpine both stages; server-name label
  `io.modelcontextprotocol.server.name="io.github.CloudCorpRecords/jobfeed"`
  matches `server.json`)
- `tsconfig.json` (fleet-identical, 318 bytes), `.gitignore`,
  `package-lock.json`, `README.md` (fresh prose), `LICENSE` (MIT,
  Copyright (c) 2026 Rene Turcios), `CHANGELOG.md` (single 0.1.0 entry,
  2026-10-27)
- `src/index.ts`, `src/cli.ts`, `src/mcp.ts`, `src/types.ts`,
  `src/forward.ts` (core; exports `VERSION = "0.1.0"`)
- `test/forward.test.ts`
- `.github/workflows/{ci.yml, publish.yml, publish-container.yml,
  registry-publish.yml}` (container workflow: IMAGE
  `ghcr.io/cloudcorprecords/jobfeed`, smoke assertion on server name
  `jobfeed`)

Plus `BUILD-REPORT.md` (this file) and the `parity-out/` harness output.

## Design

- Forwarding client to `https://mcp.getfairquery.com/jobs/mcp` (pinned),
  overridable via `FAIRQUERY_JOBS_MCP_URL` (labelled reconstruction).
  tools/call is forwarded as a streamable-HTTP JSON-RPC client:
  initialize (protocolVersion `2025-03-26`, clientInfo `jobfeed`) →
  notifications/initialized → tools/call, honouring `Mcp-Session-Id`
  when issued; session established lazily and reused per client.
  Plain-JSON and SSE replies both parsed; the matching-id message
  wins; upstream results pass through verbatim (including `isError`
  and extra fields such as `structuredContent`).
- The upstream record pins NO auth header. When
  `FAIRQUERY_JOBS_API_KEY` is set, an
  `Authorization: Bearer <value>` header is sent on every upstream
  request (labelled reconstruction — the capture was keyless). When
  unset, no key header is sent. Both branches are covered by tests,
  as is the absence of any other key header.
- Upstream failures (JSON-RPC error, non-2xx status, malformed body,
  throwing/timing-out fetch) surface as `jobfeed error:` text
  results (labelled reconstruction).
- Registration via the MCP SDK **low-level** `Server` API
  (`ListToolsRequestSchema` / `CallToolRequestSchema` handlers) serving
  the fixture literals exactly; no `McpServer` + zod registration.
  `src/mcp.ts` also exports `createServer` / `startMcpServer` /
  `handleCallTool` so the MCP layer is testable without a transport;
  the CLI's `mcp` subcommand starts it over stdio.
- Core takes an injectable fetch (`ForwardDeps.fetchFn`), so all tests
  run against a stubbed JSON-RPC upstream. No live network calls in
  tests; no live call claimed anywhere. The captured surface is
  read-only public job-board data only; no applying, messaging, or
  candidate-data tool exists in it — none was added.

## Lockfile (Route 3, clean from birth)

Generated in a temp dir (`/tmp/jobfeed-lock`) containing only the new
`package.json`: `npm install --package-lock-only --ignore-scripts
--offline`. Verified: parses, `name == @reneturcios/jobfeed`,
**128 package entries**; copied into the build dir with matching
sha256 (`9f3d608d3419016fc46cd6d82ad7bd8108ce1339e466ab2c2085529e1cf1a096`
on both sides). Then `npm install --offline --ignore-scripts` in the
build dir for `node_modules`. No write-guard failure occurred, so no
/tmp dist staging fallback was needed; `dist/` was built in-tree
normally.

## Verification (all in the build dir unless noted)

- `npx tsc --noEmit` → exit 0
- `npm run build` → real `dist/` (cli.js 2.3K, forward.js 58K,
  mcp.js 2.7K, all non-empty, with `.d.ts` + source maps)
- `node dist/cli.js --version` → `0.1.0`; unknown subcommand → usage on
  stderr, exit 2
- `npm test` → **40 tests, 40 pass, 0 fail** (8 suites: registration
  integrity — served tools deep-equal the fixture's full 7 tool
  objects, names in order, required fields and every property key in
  order per tool; session establishment/reuse/session-id handling;
  env URL override; Authorization Bearer header present on every
  request when the key is set / absent when unset / no other key
  header in either case; verbatim argument forwarding for all 7
  tools; verbatim result pass-through incl. upstream isError and
  SSE; JSON-RPC/init/malformed/HTTP/throw/timeout failures →
  `jobfeed error:`; parseRpcBody; MCP-layer validation; CLI
  --version / unknown exit 2 / bad-JSON exit 2)
- Parity: `python3 harness/parity.py --original
  harness/fixtures/fairquery-jobs-tools-original.json --rebuild
  "stdio:node builds/jobfeed/dist/cli.js mcp" --out
  builds/jobfeed/parity-out` (run from `~/workspace/mcp-rebuild-100`)
  → **PASS, parity 100.0, 7/7 identical, no missing/extra/schema
  diffs** (see `parity-out/parity.json`)
- Consistency sweep: package.json version = server.json top-level =
  npm-entry version = OCI tag = core `VERSION` = CHANGELOG heading
  (0.1.0); package.json `mcpName` = server.json `name` = Dockerfile
  label; server.json description measured at 97 chars; OCI entry
  confirmed to have no `version` field.

Clean-room: all prose and code written fresh for jobfeed; only the
mechanics were patterned on the sibling faregrid build, and only the
fixture's tool literals are served verbatim.
