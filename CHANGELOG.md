# Changelog

## 0.1.0 (2026-10-27)

- First release: a forwarding client for the hosted Fairquery jobs MCP server, serving all 7 captured tools locally for tools/list and forwarding every tools/call upstream over a streamable-HTTP JSON-RPC session (initialize, notifications/initialized, tools/call, honouring the Mcp-Session-Id header when issued).
- Tools: `jobs_get_board`, `jobs_find_board`, `jobs_check_open`, `jobs_get_job`, `jobs_list_seed_boards`, `jobs_search_by_location`, `jobs_search_companies`.
- Upstream results pass through verbatim; upstream failures surface as `jobfeed error:` text results.
- One bin serves the CLI (one subcommand per tool, plus `--version`) and the stdio MCP server (`mcp` subcommand). Upstream endpoint overridable via `FAIRQUERY_JOBS_MCP_URL`; when `FAIRQUERY_JOBS_API_KEY` is set it is sent as an `Authorization: Bearer <value>` header on every upstream request.
