import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import {
  JobfeedClient,
  callTool,
  createClient,
  DEFAULT_ENDPOINT_URL,
  parseRpcBody,
  PROTOCOL_VERSION,
  TOOL_DEFS,
  TOOL_NAMES,
  VERSION,
} from "../src/forward.js";
import { handleCallTool } from "../src/mcp.js";
import type {
  FetchFn,
  FetchResponseLike,
  ToolDef,
  ToolResult,
} from "../src/types.js";

/**
 * Every test runs against a stubbed JSON-RPC upstream
 * implementing the streamable-HTTP session flow
 * (initialize -> notifications/initialized -> tools/call):
 * no live network, no live call — the real Fairquery
 * endpoint is never contacted.
 */

const FIXTURE_URL = new URL(
  "../../../harness/fixtures/fairquery-jobs-tools-original.json",
  import.meta.url,
);
const FIXTURE_AVAILABLE = existsSync(FIXTURE_URL);
const fixture = (
  FIXTURE_AVAILABLE
    ? JSON.parse(readFileSync(FIXTURE_URL, "utf-8"))
    : { tools: [] }
) as {
  tools: ToolDef[];
};

/**
 * Publish-survival guard (Wave 25 preflight, proven Wave 24 pattern):
 * the parity fixture lives in the build harness, outside the published
 * repo tree, so fixture-dependent tests skip cleanly when it is absent;
 * with the fixture present they run in full, with no skips.
 */
function skipWithoutFixture(t: {
  skip: (message: string) => void;
}): boolean {
  if (FIXTURE_AVAILABLE) return false;
  t.skip("parity fixture lives in the build harness, not the repo tree");
  return true;
}

const SAMPLE_RESULT = {
  content: [{ type: "text", text: "{\"jobs\":[],\"count\":0}" }],
  structuredContent: { count: 0 },
};

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

interface FakeOptions {
  callResult?: Record<string, unknown>;
  callBodyText?: string;
  callError?: Record<string, unknown>;
  callStatus?: number;
  initError?: Record<string, unknown>;
  throwOn?: "initialize" | "tools/call";
  sessionId?: string | null;
  hangOnCall?: boolean;
  sse?: boolean;
}

function makeResponse(
  status: number,
  bodyText: string,
  headers: Record<string, string> = {},
): FetchResponseLike {
  const lowered = new Map(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => lowered.get(name.toLowerCase()) ?? null },
    text: async () => bodyText,
  };
}

function jsonResponse(
  status: number,
  payload: unknown,
  headers: Record<string, string> = {},
) {
  return makeResponse(status, JSON.stringify(payload), headers);
}

function makeUpstream(options: FakeOptions = {}): {
  fetchFn: FetchFn;
  calls: Captured[];
} {
  const calls: Captured[] = [];
  const fetchFn: FetchFn = async (url, init) => {
    const body = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
    calls.push({ url, headers: init?.headers ?? {}, body });
    const method = body.method as string;
    if (options.throwOn === method) throw new Error("socket hang up");
    if (method === "initialize") {
      if (options.initError !== undefined) {
        return jsonResponse(200, {
          jsonrpc: "2.0",
          id: body.id,
          error: options.initError,
        });
      }
      const headers: Record<string, string> = {};
      const sessionId =
        options.sessionId === undefined ? "sess-xyz" : options.sessionId;
      if (sessionId !== null) headers["mcp-session-id"] = sessionId;
      return jsonResponse(
        200,
        {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {},
            serverInfo: { name: "fairquery-jobs", version: "1.1.18" },
          },
        },
        headers,
      );
    }
    if (method === "notifications/initialized") {
      return makeResponse(202, "");
    }
    if (method === "tools/call") {
      if (options.hangOnCall) {
        return new Promise<FetchResponseLike>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal) {
            if (signal.aborted) {
              reject(new Error("aborted"));
              return;
            }
            signal.addEventListener("abort", () => reject(new Error("aborted")));
          }
        });
      }
      if (options.callBodyText !== undefined) {
        return makeResponse(options.callStatus ?? 200, options.callBodyText);
      }
      if (options.callError !== undefined) {
        return jsonResponse(200, {
          jsonrpc: "2.0",
          id: body.id,
          error: options.callError,
        });
      }
      const result = options.callResult ?? SAMPLE_RESULT;
      const payload = { jsonrpc: "2.0", id: body.id, result };
      if (options.sse) {
        return makeResponse(
          200,
          `event: message\ndata: ${JSON.stringify(payload)}\n\n`,
        );
      }
      return jsonResponse(options.callStatus ?? 200, payload);
    }
    return jsonResponse(200, {});
  };
  return { fetchFn, calls };
}

function stubClient(options: FakeOptions = {}, extra: Record<string, unknown> = {}) {
  const upstream = makeUpstream(options);
  const c = new JobfeedClient({
    fetchFn: upstream.fetchFn,
    env: {},
    ...extra,
  });
  return { client: c, calls: upstream.calls };
}

function textOf(result: ToolResult): string {
  const content = result.content as Array<{ type: string; text: string }>;
  return content[0].text;
}

function methods(calls: Captured[]): string[] {
  return calls.map((c) => c.body.method as string);
}

/* ------------------------------------------------------------------ */

describe("registration integrity (captured surface)", () => {
  it("serves exactly the fixture's 7 tools, deep-equal", (t) => {
    if (skipWithoutFixture(t)) return;
    assert.equal(fixture.tools.length, 7);
    assert.deepEqual(TOOL_DEFS, fixture.tools);
  });

  it("serves the 7 tool names in fixture order", () => {
    assert.deepEqual(TOOL_NAMES, [
      "jobs_get_board",
      "jobs_find_board",
      "jobs_check_open",
      "jobs_get_job",
      "jobs_list_seed_boards",
      "jobs_search_by_location",
      "jobs_search_companies",
    ]);
  });

  it("carries exactly the fixture's required fields per tool", () => {
    const required = new Map(
      TOOL_DEFS.map((t) => [
        t.name,
        (t.inputSchema as { required?: string[] }).required ?? [],
      ]),
    );
    assert.deepEqual(required.get("jobs_get_board"), ["ats", "slug"]);
    assert.deepEqual(required.get("jobs_find_board"), ["company"]);
    assert.deepEqual(required.get("jobs_check_open"), []);
    assert.deepEqual(required.get("jobs_get_job"), []);
    assert.deepEqual(required.get("jobs_list_seed_boards"), []);
    assert.deepEqual(required.get("jobs_search_by_location"), []);
    assert.deepEqual(required.get("jobs_search_companies"), []);
  });

  it("carries every fixture property, in order, per tool", (t) => {
    if (skipWithoutFixture(t)) return;
    for (let i = 0; i < fixture.tools.length; i++) {
      const served = Object.keys(
        (TOOL_DEFS[i].inputSchema as { properties: object }).properties,
      );
      const expected = Object.keys(
        (fixture.tools[i].inputSchema as { properties: object }).properties,
      );
      assert.deepEqual(served, expected);
    }
  });
});

/* ------------------------------------------------------------------ */

describe("session establishment and reuse", () => {
  it("runs initialize, notifications/initialized, then tools/call in order", async () => {
    const { client: c, calls } = stubClient();
    const out = await c.callTool("jobs_get_board", {
      ats: "ashby",
      slug: "ramp",
    });
    assert.equal(out.isError, undefined);
    assert.deepEqual(methods(calls), [
      "initialize",
      "notifications/initialized",
      "tools/call",
    ]);
    assert.ok(calls.every((call) => call.url === DEFAULT_ENDPOINT_URL));
    assert.equal(DEFAULT_ENDPOINT_URL, "https://mcp.getfairquery.com/jobs/mcp");

    const initParams = calls[0].body.params as Record<string, unknown>;
    assert.equal(initParams.protocolVersion, PROTOCOL_VERSION);
    assert.deepEqual(initParams.capabilities, {});
    assert.deepEqual(initParams.clientInfo, {
      name: "jobfeed",
      version: VERSION,
    });
    assert.equal(calls[0].headers["Mcp-Session-Id"], undefined);
    for (const call of calls) {
      assert.equal(call.headers["Content-Type"], "application/json");
      assert.equal(
        call.headers["Accept"],
        "application/json, text/event-stream",
      );
    }
    assert.equal(calls[1].headers["Mcp-Session-Id"], "sess-xyz");
    assert.equal(calls[2].headers["Mcp-Session-Id"], "sess-xyz");
  });

  it("establishes the session lazily once and reuses it on later calls", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool("jobs_get_board", { ats: "ashby", slug: "ramp" });
    await c.callTool("jobs_find_board", { company: "Ramp" });
    assert.deepEqual(methods(calls), [
      "initialize",
      "notifications/initialized",
      "tools/call",
      "tools/call",
    ]);
    assert.equal(calls[3].headers["Mcp-Session-Id"], "sess-xyz");
    assert.notEqual(calls[2].body.id, calls[3].body.id);
  });

  it("sends no session header when the upstream issues none", async () => {
    const { client: c, calls } = stubClient({ sessionId: null });
    const out = await c.callTool("jobs_get_board", { ats: "ashby", slug: "ramp" });
    assert.equal(out.isError, undefined);
    assert.ok(calls.every((call) => call.headers["Mcp-Session-Id"] === undefined));
  });

  it("honours the FAIRQUERY_JOBS_MCP_URL env override", async () => {
    const upstream = makeUpstream();
    const c = new JobfeedClient({
      fetchFn: upstream.fetchFn,
      env: { FAIRQUERY_JOBS_MCP_URL: "https://staging.example.com/mcp" },
    });
    await c.callTool("jobs_get_board", { ats: "ashby", slug: "ramp" });
    assert.ok(
      upstream.calls.every((call) => call.url === "https://staging.example.com/mcp"),
    );
  });

  it("honours an explicit url override over the default endpoint", async () => {
    const upstream = makeUpstream();
    const c = createClient({
      fetchFn: upstream.fetchFn,
      env: {},
      url: "https://alt.example.com/mcp",
    });
    await c.callTool("jobs_get_board", { ats: "ashby", slug: "ramp" });
    assert.ok(
      upstream.calls.every((call) => call.url === "https://alt.example.com/mcp"),
    );
  });
});

/* ------------------------------------------------------------------ */

describe("upstream key header", () => {
  it("sends Authorization: Bearer on every request when FAIRQUERY_JOBS_API_KEY is set", async () => {
    const upstream = makeUpstream();
    const c = new JobfeedClient({
      fetchFn: upstream.fetchFn,
      env: { FAIRQUERY_JOBS_API_KEY: "fair-key-42" },
    });
    await c.callTool("jobs_get_board", { ats: "ashby", slug: "ramp" });
    assert.equal(upstream.calls.length, 3);
    assert.ok(
      upstream.calls.every(
        (call) => call.headers["Authorization"] === "Bearer fair-key-42",
      ),
    );
  });

  it("sends no Authorization header when FAIRQUERY_JOBS_API_KEY is unset", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool("jobs_get_board", { ats: "ashby", slug: "ramp" });
    assert.ok(calls.every((call) => call.headers["Authorization"] === undefined));
  });

  it("never sends an x-rapidapi-key header, with or without a key", async () => {
    const withKey = makeUpstream();
    const c1 = new JobfeedClient({
      fetchFn: withKey.fetchFn,
      env: { FAIRQUERY_JOBS_API_KEY: "fair-key-42" },
    });
    await c1.callTool("jobs_get_board", { ats: "ashby", slug: "ramp" });
    assert.ok(
      withKey.calls.every((call) => call.headers["x-rapidapi-key"] === undefined),
    );
    const { client: c2, calls } = stubClient();
    await c2.callTool("jobs_get_board", { ats: "ashby", slug: "ramp" });
    assert.ok(calls.every((call) => call.headers["x-rapidapi-key"] === undefined));
  });
});

/* ------------------------------------------------------------------ */

describe("tools/call forwarding", () => {
  it("forwards jobs_get_board arguments verbatim", async () => {
    const { client: c, calls } = stubClient();
    const args = {
      ats: "ashby",
      slug: "ramp",
      titleIncludes: ["engineer"],
      remote: "only",
      limit: 5,
    };
    await c.callTool("jobs_get_board", args);
    const params = calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, "jobs_get_board");
    assert.deepEqual(params.arguments, args);
  });

  it("forwards jobs_find_board arguments verbatim", async () => {
    const { client: c, calls } = stubClient();
    const args = { company: "ramp.com" };
    await c.callTool("jobs_find_board", args);
    const params = calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, "jobs_find_board");
    assert.deepEqual(params.arguments, args);
  });

  it("forwards jobs_check_open with a jobKey verbatim", async () => {
    const { client: c, calls } = stubClient();
    const args = { jobKey: "greenhouse:stripe:8172503" };
    await c.callTool("jobs_check_open", args);
    const params = calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, "jobs_check_open");
    assert.deepEqual(params.arguments, args);
  });

  it("forwards jobs_get_job with ats, slug and jobId verbatim", async () => {
    const { client: c, calls } = stubClient();
    const args = { ats: "greenhouse", slug: "stripe", jobId: "8172503" };
    await c.callTool("jobs_get_job", args);
    const params = calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, "jobs_get_job");
    assert.deepEqual(params.arguments, args);
  });

  it("forwards jobs_list_seed_boards with no arguments", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool("jobs_list_seed_boards", {});
    const params = calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, "jobs_list_seed_boards");
    assert.deepEqual(params.arguments, {});
  });

  it("forwards jobs_search_by_location arguments verbatim", async () => {
    const { client: c, calls } = stubClient();
    const args = {
      locations: ["Costa Mesa"],
      descriptionIncludes: ["avionics"],
    };
    await c.callTool("jobs_search_by_location", args);
    const params = calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, "jobs_search_by_location");
    assert.deepEqual(params.arguments, args);
  });

  it("forwards jobs_search_companies arguments verbatim", async () => {
    const { client: c, calls } = stubClient();
    const args = {
      companies: ["stripe.com", "ramp.com"],
      titleIncludes: ["engineer"],
      countries: ["US"],
      onlyNew: true,
    };
    await c.callTool("jobs_search_companies", args);
    const params = calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, "jobs_search_companies");
    assert.deepEqual(params.arguments, args);
  });

  it("passes the upstream result through verbatim, including extra fields", async () => {
    const { client: c } = stubClient();
    const out = await c.callTool("jobs_get_board", { ats: "ashby", slug: "ramp" });
    assert.deepEqual(out, SAMPLE_RESULT);
  });

  it("passes an upstream isError result through untouched", async () => {
    const upstreamResult = {
      content: [{ type: "text", text: "no board found" }],
      isError: true,
    };
    const { client: c } = stubClient({ callResult: upstreamResult });
    const out = await c.callTool("jobs_find_board", { company: "nope.example" });
    assert.deepEqual(out, upstreamResult);
  });

  it("reads an SSE-framed tools/call response", async () => {
    const { client: c } = stubClient({ sse: true });
    const out = await c.callTool("jobs_list_seed_boards", {});
    assert.equal(out.isError, undefined);
    assert.deepEqual(out, SAMPLE_RESULT);
  });

  it("the one-shot callTool helper forwards under the right tool name", async () => {
    const upstream = makeUpstream();
    const out = await callTool(
      "jobs_get_board",
      { ats: "ashby", slug: "ramp" },
      { fetchFn: upstream.fetchFn, env: {} },
    );
    assert.equal(out.isError, undefined);
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, "jobs_get_board");
    assert.deepEqual(params.arguments, { ats: "ashby", slug: "ramp" });
  });
});

/* ------------------------------------------------------------------ */

describe("upstream failures surface as jobfeed error text", () => {
  it("maps a JSON-RPC error to `jobfeed error: <message>`", async () => {
    const { client: c } = stubClient({
      callError: { code: -32000, message: "board not found" },
    });
    const out = await c.callTool("jobs_get_board", { ats: "ashby", slug: "nope" });
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "jobfeed error: board not found");
  });

  it("maps an initialize JSON-RPC error to jobfeed error text", async () => {
    const { client: c } = stubClient({
      initError: { code: -32600, message: "bad initialize" },
    });
    const out = await c.callTool("jobs_get_board", { ats: "ashby", slug: "ramp" });
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "jobfeed error: bad initialize");
  });

  it("maps an unparseable upstream response to a malformed-response error", async () => {
    const { client: c } = stubClient({ callBodyText: "<html>oops</html>" });
    const out = await c.callTool("jobs_get_board", { ats: "ashby", slug: "ramp" });
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "jobfeed error: malformed response");
  });

  it("maps a non-2xx upstream status to jobfeed error text", async () => {
    const { client: c } = stubClient({
      callBodyText: "internal error",
      callStatus: 500,
    });
    const out = await c.callTool("jobs_get_board", { ats: "ashby", slug: "ramp" });
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "jobfeed error: HTTP 500");
  });

  it("maps a throwing fetch to jobfeed error text", async () => {
    const { client: c } = stubClient({ throwOn: "tools/call" });
    const out = await c.callTool("jobs_get_board", { ats: "ashby", slug: "ramp" });
    assert.equal(out.isError, true);
    assert.match(textOf(out), /^jobfeed error: /);
  });

  it("maps a throwing initialize fetch to jobfeed error text", async () => {
    const { client: c } = stubClient({ throwOn: "initialize" });
    const out = await c.callTool("jobs_get_board", { ats: "ashby", slug: "ramp" });
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "jobfeed error: socket hang up");
  });

  it("maps a timed-out call to jobfeed error text", async () => {
    const { client: c } = stubClient({ hangOnCall: true }, { timeoutMs: 20 });
    const out = await c.callTool("jobs_get_board", { ats: "ashby", slug: "ramp" });
    assert.equal(out.isError, true);
    assert.match(textOf(out), /^jobfeed error: /);
  });
});

/* ------------------------------------------------------------------ */

describe("parseRpcBody", () => {
  it("parses plain JSON and picks the message with the matching id", () => {
    const body = '{"jsonrpc":"2.0","id":7,"result":{"ok":true}}';
    assert.deepEqual(parseRpcBody(body, 7), {
      jsonrpc: "2.0",
      id: 7,
      result: { ok: true },
    });
  });

  it("parses SSE data lines", () => {
    const body =
      'event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"ok":true}}\n\n';
    assert.deepEqual(parseRpcBody(body, 2), {
      jsonrpc: "2.0",
      id: 2,
      result: { ok: true },
    });
  });

  it("returns null for empty and unparseable bodies", () => {
    assert.equal(parseRpcBody(""), null);
    assert.equal(parseRpcBody("not json at all"), null);
  });
});

/* ------------------------------------------------------------------ */

describe("MCP layer validation", () => {
  it("rejects an unknown tool before any network hop", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await assert.rejects(
      () => handleCallTool(c, "not_a_tool", {}),
      (err: unknown) => err instanceof McpError,
    );
    assert.equal(upstream.calls.length, 0);
  });

  it("rejects non-object arguments before any network hop", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await assert.rejects(
      () => handleCallTool(c, "jobs_get_board", ["nope"]),
      (err: unknown) => err instanceof McpError,
    );
    assert.equal(upstream.calls.length, 0);
  });

  it("forwards a valid call through the MCP layer unchanged", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    const out = await handleCallTool(c, "jobs_find_board", {
      company: "Ramp",
    });
    assert.deepEqual(out, SAMPLE_RESULT);
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.deepEqual(params.arguments, {
      company: "Ramp",
    });
  });
});

/* ------------------------------------------------------------------ */

describe("CLI", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

  function runCli(args: string[]) {
    return spawnSync(process.execPath, ["--import", "tsx", cliPath, ...args], {
      cwd: root,
      encoding: "utf8",
      timeout: 30000,
    });
  }

  it("--version prints 0.1.0 and exits 0", () => {
    const res = runCli(["--version"]);
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), "0.1.0");
  });

  it("an unknown command prints usage on stderr and exits 2", () => {
    const res = runCli(["not-a-tool"]);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /Usage:/);
  });

  it("a non-JSON argument exits 2", () => {
    const res = runCli(["jobs_get_board", "not json"]);
    assert.equal(res.status, 2);
  });

  it("a JSON array argument exits 2", () => {
    const res = runCli(["jobs_get_board", "[]"]);
    assert.equal(res.status, 2);
  });
});
