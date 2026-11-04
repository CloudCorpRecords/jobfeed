# jobfeed

jobfeed is a small local bridge to the hosted Fairquery
jobs MCP server, which reads live job boards from their
official public sources. Ask for one company's board,
resolve a company to the board it uses, re-check whether
a single job is still open, fetch one job in full, list
the verified starter boards, or search that starter list
by place and role — and, through the paid company search,
monitor openings across many companies with history.

The bridge keeps no job data of its own. It serves the
upstream server's tool list locally, exactly as captured
from the live endpoint, and forwards each tool call
upstream, returning the result untouched. The captured
surface is read-only public job-board data: there is no
applying, messaging, or candidate data in it.

## Tools

- `jobs_get_board` — every job currently published on
  one board. Required: `ats` and `slug`. Optional filters
  include title includes/excludes, locations, countries,
  remote, posted-within days, description inclusion, and
  paging.
- `jobs_find_board` — resolve a company name, domain, or
  careers/board URL to its public board. Required:
  `company`.
- `jobs_check_open` — re-check whether one job is still
  published. Takes a `jobKey`, or `ats` + `slug` +
  `jobId`, with optional `includeDescription`.
- `jobs_get_job` — one published job's full detail, from
  a `jobKey` or `ats` + `slug` + `jobId`.
- `jobs_list_seed_boards` — the bundled starter list of
  verified boards, optionally narrowed by `ats`, with
  paging.
- `jobs_search_by_location` — search the starter list by
  place and role, with no company name. Requires a place
  signal: locations, countries, or remote `"only"`.
- `jobs_search_companies` — the paid multi-company
  search and monitoring tool, with history, new/closed
  and repost signals across many companies or boards.

Boards cover Greenhouse, Lever, and Ashby, plus named
Personio, Pinpoint, and Gem feeds.

## Configuration

- `FAIRQUERY_JOBS_MCP_URL` (optional) — override the
  upstream endpoint. Defaults to
  `https://mcp.getfairquery.com/jobs/mcp`. (The override
  hook is this rebuild's own labelled reconstruction.)
- `FAIRQUERY_JOBS_API_KEY` (optional) — when set, every
  upstream request carries an
  `Authorization: Bearer <key>` header. When it is not
  set, no key header is sent. The upstream record pins
  no auth header, so this forwarding is also a labelled
  reconstruction; the original surface was captured
  keyless.

### Forwarding mechanics

On the first tool call the client opens a streamable
HTTP session with the upstream: a JSON-RPC `initialize`
request (protocolVersion `2025-03-26`, clientInfo name
`jobfeed`), then a `notifications/initialized`
notification, then the `tools/call` request carrying
the caller's arguments unchanged. When the upstream
answers `initialize` with an `Mcp-Session-Id` header,
that value rides on every later request of the session,
which is reused for the life of the process. Replies
may arrive as plain JSON or as server-sent events;
both are read.

Successful upstream results pass through verbatim,
including any `isError` flag the upstream sets.
Failures — a JSON-RPC error, a non-2xx status, an
unreadable response, or a request that cannot be
completed — come back as an `isError` result whose
text starts with `jobfeed error:` (this rendering
is this rebuild's own labelled reconstruction).

## CLI

Each tool is also a subcommand taking one JSON argument
string:

```bash
npx @reneturcios/jobfeed jobs_get_board '{"ats":"ashby","slug":"ramp"}'
npx @reneturcios/jobfeed jobs_find_board '{"company":"ramp.com"}'
npx @reneturcios/jobfeed jobs_search_by_location '{"locations":["Costa Mesa"],"descriptionIncludes":["avionics"]}'
npx @reneturcios/jobfeed --version
```

Exit codes: `0` on success, `1` on an `isError`
result, `2` on a usage error.

## MCP server

```bash
npx -y @reneturcios/jobfeed mcp
```

MCP client config:

```json
{
  "mcpServers": {
    "jobfeed": {
      "command": "npx",
      "args": ["-y", "@reneturcios/jobfeed", "mcp"]
    }
  }
}
```

## Docker

```bash
docker run -i ghcr.io/cloudcorprecords/jobfeed
docker run --rm ghcr.io/cloudcorprecords/jobfeed --version
```

The container's default command is `mcp`, so the first
form is a stdio MCP server; any other arguments reach
the CLI normally.

## Development

```bash
npm install
npm run build
npm test
npm run dev
```

The test suite runs entirely against a stubbed
JSON-RPC upstream — no live network calls.

## License

MIT — see `LICENSE`.
