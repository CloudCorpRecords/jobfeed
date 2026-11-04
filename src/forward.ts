/**
 * jobfeed core: a forwarding client for the hosted
 * Fairquery jobs MCP server.
 *
 * Nothing is computed locally. tools/list is answered
 * from the literal tool definitions below, taken verbatim
 * from a live capture of the upstream server (name, title,
 * description and inputSchema exactly as captured; the
 * capture's annotations and outputSchema blocks are not
 * reproduced). A tools/call is forwarded over a
 * streamable-HTTP JSON-RPC session: an initialize POST, a
 * notifications/initialized POST, then the tools/call
 * POST, honouring the Mcp-Session-Id response header when
 * the upstream issues one. The session is established
 * lazily on the first forwarded call and reused for the
 * lifetime of the client.
 *
 * The upstream endpoint is pinned to
 * https://mcp.getfairquery.com/jobs/mcp and can be overridden with
 * the FAIRQUERY_JOBS_MCP_URL environment variable (that override
 * is a labelled reconstruction). The upstream record pins
 * NO auth header. When FAIRQUERY_JOBS_API_KEY is set in the
 * environment, every upstream request carries an
 * `Authorization: Bearer <key>` header (that forwarding is
 * a labelled reconstruction — the capture itself was taken
 * keyless). When the variable is unset, no key header is
 * sent.
 *
 * Upstream results pass through verbatim, including any
 * isError flag and any extra result fields. Failures — a
 * JSON-RPC error from the upstream, a non-2xx status, an
 * unparseable response, or a fetch that throws or times
 * out — surface as an isError result whose text starts
 * with `jobfeed error:` (that rendering is a labelled
 * reconstruction). Responses may be plain JSON or SSE
 * (data: lines); the JSON-RPC message with the matching
 * id wins.
 */
import type {
  FetchFn,
  FetchResponseLike,
  ForwardDeps,
  ToolArgs,
  ToolDef,
  ToolResult,
} from "./types.js";

export const VERSION = "0.1.0";

export const DEFAULT_ENDPOINT_URL = "https://mcp.getfairquery.com/jobs/mcp";

export const DEFAULT_TIMEOUT_MS = 30000;

export const PROTOCOL_VERSION = "2025-03-26";

/* ------------------------------------------------------------------ */
/* Tool definitions (tools/list literals, verbatim from the live       */
/* capture in harness/fixtures/fairquery-jobs-tools-original.json)     */
/* ------------------------------------------------------------------ */

export const TOOL_DEFS: ToolDef[] = [
  {
    "name": "jobs_get_board",
    "title": "Get live jobs from one ATS board (free)",
    "description": "WHAT: Fetch every job currently published on ONE company board from its official public ATS API (Greenhouse, Lever or Ashby), from Personio's documented XML feed, from Pinpoint's documented postings.json, or from a named Gem job board, normalize it and filter it on this Worker.\nWHEN: You know the board (ats + slug), e.g. from jobs_find_board or a careers-page link, and want its live openings now. For Personio, Pinpoint and Gem you already know the company account, subdomain or vanity.\nWHEN NOT: One known job's full detail (jobs_get_job). Jobs in a place or by role across the starter list, without a company name (jobs_search_by_location). Do not ask the user for a company and do not call this tool or jobs_find_board first for that ask. Many companies at once, history (new/closed/reposted since last run), or careers-page discovery at scale: use jobs_search_companies (paid). Unknown Greenhouse/Lever/Ashby board: use jobs_find_board first. Personio, Pinpoint and Gem are never discovered. SmartRecruiters, LinkedIn, Workday, Workable, Recruitee and Rippling are not supported and never contacted.\nBEHAVIOR: Runs on this Fairquery-hosted Worker (Cloudflare), not on the caller's machine; inputs leave the client. This Worker's code is designed not to store inputs or results. The slug is sent to the public ATS host in the requests below. Greenhouse, Lever and Ashby: one GET to the documented API host only (very large Greenhouse boards: a second, lighter GET). Personio: robots.txt, then GET https://{account}.jobs.personio.de/xml only; all Personio accounts share one lane, one at a time, at least 1.5 s apart. Pinpoint: that tenant's robots.txt, then GET https://{subdomain}.pinpointhq.com/postings.json only (not jobs.json, not /api/v1); each subdomain is its own lane, one at a time, at least 1 s apart. Gem: GET https://api.gem.com/job_board/v0/{vanity}/job_posts/ only (no API key, no POST /applications); every vanity shares one lane, one at a time, at least 1 s apart. Pinpoint and Gem description_text stay empty (link out; the ad body is not copied). Gem job_url points at jobs.gem.com. Pinpoint job_url is the tenant listing link. Emails and phones are not kept from a Pinpoint posting. Nothing stored, no history: first_seen_at = now and change = null. Any HTTP 403/429 stops that host for the session (kill switch, HOST_BLOCKED error). A blocked Personio or Pinpoint host does not block other companies. A blocked Gem response stops api.gem.com for the session. Lever requests are spaced 1 s apart (its robots.txt Crawl-delay).\nCOST: No APIFY_TOKEN, no billing.\nRETURNS: Paged \"job\" rows. compensation only when the ATS publishes it; posted_at is the ATS date or null (never guessed); age_basis says how age_days was derived.\nPARAMETERS: All filters are AND-ed; values inside one filter are OR-ed. titleIncludes/titleExcludes match whole words (\"engineer\" does not match \"Engineering\"). countries uses the ATS's structured country where present (Lever, Ashby) and a place-name list otherwise; rows without any country are dropped when countries is set. postedWithinDays drops rows with posted_at = null. Paging re-fetches the board, so pages from different calls can shift if the employer edits the board in between.\nEXAMPLE: {\"ats\":\"ashby\",\"slug\":\"ramp\",\"titleIncludes\":[\"engineer\"],\"remote\":\"only\"} -> remote engineering roles at Ramp with salary ranges.",
    "inputSchema": {
      "type": "object",
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "properties": {
        "ats": {
          "type": "string",
          "enum": [
            "greenhouse",
            "lever",
            "ashby",
            "personio",
            "pinpoint",
            "gem"
          ],
          "description": "Required. The applicant-tracking system hosting the board: \"greenhouse\" | \"lever\" | \"ashby\" | \"personio\" | \"pinpoint\" | \"gem\". Personio, Pinpoint and Gem are the account, subdomain or vanity you name, not a discovered board. Example: \"ashby\""
        },
        "slug": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$",
          "description": "Required. Board slug as it appears in the public board URL (case-insensitive): boards.greenhouse.io/{slug}, jobs.lever.co/{slug}, jobs.ashbyhq.com/{slug}, the Personio account in {account}.jobs.personio.de, the Pinpoint subdomain in {subdomain}.pinpointhq.com, or the Gem vanity in jobs.gem.com/{vanity}. Named feeds reject a dot. 1-100 chars. Example: \"ramp\" or \"acme\""
        },
        "titleIncludes": {
          "description": "Optional, 0-50 strings, any-of. Keep titles containing any of these whole words/phrases, case-insensitive. Example: [\"engineer\",\"data scientist\"]",
          "maxItems": 50,
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1,
            "maxLength": 100
          }
        },
        "titleExcludes": {
          "description": "Optional, 0-50 strings, any-of. Drop titles containing any of these. Example: [\"intern\",\"manager\"]",
          "maxItems": 50,
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1,
            "maxLength": 100
          }
        },
        "locations": {
          "description": "Optional, 0-50 strings, any-of. Substring match on location text. US state names and codes match both ways (FL and Florida); NYC, SF, LA, DC, Tampa Bay and other US metro aliases match. \"remote\" also matches ATS remote flags. Example: [\"new york\",\"berlin\"]",
          "maxItems": 50,
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1,
            "maxLength": 100
          }
        },
        "countries": {
          "description": "Optional ISO-3166 alpha-2 codes, any-of, case-insensitive. Example: [\"US\",\"DE\"]",
          "maxItems": 50,
          "type": "array",
          "items": {
            "type": "string",
            "pattern": "^[A-Za-z]{2}$"
          }
        },
        "remote": {
          "description": "Optional, \"any\" | \"only\" | \"exclude\", default \"any\"",
          "type": "string",
          "enum": [
            "any",
            "only",
            "exclude"
          ]
        },
        "postedWithinDays": {
          "description": "Optional integer 1-3650: keep jobs whose ATS publish date is at most this many days old. Example: 14",
          "type": "integer",
          "minimum": 1,
          "maximum": 3650
        },
        "longOpenDays": {
          "description": "Optional integer, default 60: rows older than this get long_open = true (a heuristic, not proof of a ghost job)",
          "type": "integer",
          "minimum": 1,
          "maximum": 3650
        },
        "includeDescription": {
          "description": "Optional boolean, default false. true adds description_text (plain text, <= 20,000 chars, e-mails/phones removed)",
          "type": "boolean"
        },
        "limit": {
          "description": "Optional page size, integer 1-500, default 50",
          "type": "integer",
          "minimum": 1,
          "maximum": 500
        },
        "offset": {
          "description": "Optional items to skip, integer >= 0, default 0; pass nextOffset from the previous response",
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "ats",
        "slug"
      ]
    }
  },
  {
    "name": "jobs_find_board",
    "title": "Find which ATS board a company uses (free)",
    "description": "WHAT: Resolve a company name, domain or careers/board URL to its public job board(s) on Greenhouse, Lever or Ashby. A Personio, Pinpoint or Gem URL (or personio:account, pinpoint:subdomain, gem:vanity) you already know is parsed on this Worker and not looked up.\nWHEN: Before jobs_get_board when you only know the company (\"Ramp\", \"sentry.io\", \"https://stripe.com/jobs\") or you have a Personio, Pinpoint or Gem career URL.\nWHEN NOT: The user asked for jobs in a place or by role and did not name a company. Call jobs_search_by_location. Do not ask them for a company and do not call this tool first. You already have ats + slug (call jobs_get_board). For many companies plus history use jobs_search_companies (paid). It cannot find Workday, Workable, Recruitee, Rippling or LinkedIn pages, and it does not discover Personio, Pinpoint or Gem boards.\nBEHAVIOR: Runs on this Fairquery-hosted Worker (Cloudflare), not on the caller's machine; inputs leave the client. This Worker's code is designed not to store inputs or results. Parts of the input are sent to public ATS hosts or the company site, as the steps below describe. Order: board-URL parsing (including personio:{account}, pinpoint:{subdomain}, gem:{vanity} and their public board URLs, no network) -> verified starter list -> the company's own website (only for a domain/URL input; robots.txt respected, <= 3 pages, private/internal IPs refused; Personio, Pinpoint and Gem hosts are not crawled) -> at most 6 GETs against the Greenhouse, Lever and Ashby APIs with slug guesses. Personio, Pinpoint and Gem are never probed and a careers-page link to them is ignored. Stops at the first hit. Nothing is cached or stored. Rate limits: max 2 parallel requests per host, Lever spaced 1 s apart, 15 s timeout per GET; ATS API network errors and HTTP 5xx are retried at most twice with backoff (0.5-1.6 s). Any HTTP 403/429 (or an HTML block page from an ATS API) stops that host for the session (kill switch, never retried, also for the other free tools): the call does not fail but adds a HOST_BLOCKED note to meta.notes, stops the careers-page step when the company site is blocked, and skips later slug probes on a stopped ATS host without sending them.\nCOST: No APIFY_TOKEN and no billing; worst case about 4 website requests (robots.txt + 3 pages) and 6 ATS API GETs per call.\nRETURNS: \"board\" rows, or one NO_BOARD_FOUND error row. via (board_url | seed_list | careers_page | slug_probe) says how the board was found; confidence is \"high\" except for slug_probe hits (\"medium\": the slug exists but may belong to a different company with the same name, so check the jobs or pass the URL from the careers page).\nPARAMETERS: company accepts three forms with different behavior: a board URL (including a Personio, Pinpoint or Gem URL, or personio:account / pinpoint:subdomain / gem:vanity) is parsed with no network call; a domain or https URL enables the careers-page step; a plain name only uses the starter list and slug probes. Slug guesses for a name drop legal suffixes and \"the\" (Inc, LLC, Ltd, GmbH, Corp, Co, PLC, AG, SA, BV) and try the joined words, the hyphenated words and the first word; probes run Greenhouse, Lever, Ashby in that order (never Personio, Pinpoint or Gem) and the first hit wins, so an ambiguous name returns at most one medium-confidence board. A starter-list match can return several boards (all high).\nEXAMPLE: {\"company\":\"ramp.com\"} -> [{\"ats\":\"ashby\",\"slug\":\"ramp\",\"via\":\"seed_list\",\"confidence\":\"high\"}].",
    "inputSchema": {
      "type": "object",
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "properties": {
        "company": {
          "type": "string",
          "minLength": 2,
          "maxLength": 300,
          "description": "Required. Company name, domain or URL, 2-300 chars. Examples: \"Ramp\", \"sentry.io\", \"https://jobs.lever.co/palantir\""
        }
      },
      "required": [
        "company"
      ]
    }
  },
  {
    "name": "jobs_check_open",
    "title": "Re-check whether one job is still published (free)",
    "description": "WHAT: Re-check ONE job on the employer's ATS right now and report open or closed.\nWHEN: Before applying, alerting or contacting about a specific job you got earlier (job_key or ats + slug + jobId), when you only need open or closed.\nWHEN NOT: One job's full detail (jobs_get_job). Listing a board (jobs_get_board). Checking many jobs at once (jobs_search_companies with confirmOpen, paid).\nBEHAVIOR: Runs on this Fairquery-hosted Worker (Cloudflare), not on the caller's machine; inputs leave the client. This Worker's code is designed not to store inputs or results. The job id and board slug are sent to the public ATS host in the requests below. Greenhouse, Lever: one GET to the documented per-job endpoint; HTTP 404 = closed. Ashby, Personio, Pinpoint and Gem have no per-job read here, so the documented board feed is fetched once and searched for the id (method \"board_listing\"). Personio is robots.txt then /xml. Pinpoint is robots.txt then /postings.json. Gem is GET /job_posts/ only. No apply URL is requested. \"open\" means currently published by the employer; it does not prove the role is still being filled.\nCOST: No APIFY_TOKEN, no billing.\nRETURNS: One \"open_check\" row (job = the full \"job\" row when includeDescription=true and the job is open, else null), or a tool error: INVALID_INPUT, BOARD_NOT_FOUND, HOST_BLOCKED or NETWORK_ERROR (the last two retryable).\nPARAMETERS: A malformed jobKey, or neither jobKey nor a complete ats + slug + jobId, returns INVALID_INPUT without a request. An Ashby, Personio, Pinpoint or Gem id costs one full board download; on Greenhouse and Lever a 404 triggers one extra board request so a closed job (status closed) is told apart from a missing board (BOARD_NOT_FOUND). includeDescription adds no request on Greenhouse and Lever and makes the Ashby or Personio board download include descriptions. Pinpoint and Gem description_text stay empty (the row links out). description_text is plain text, <= 20,000 chars, e-mails/phones removed, exactly as in jobs_get_board.\nEXAMPLE: {\"jobKey\":\"greenhouse:stripe:8172503\"} -> {\"status\":\"open\",\"method\":\"detail_endpoint\"}.",
    "inputSchema": {
      "type": "object",
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "properties": {
        "jobKey": {
          "description": "Optional if ats + slug + jobId are given; wins when both are given. The job_key field of a job row, format \"{ats}:{slug}:{job_id}\" with ats in lowercase (greenhouse | lever | ashby | personio | pinpoint | gem); any other shape returns INVALID_INPUT. Examples: \"greenhouse:stripe:8172503\", \"personio:acme:4103\", \"gem:acme:am9icG9zdA\"",
          "type": "string",
          "maxLength": 250
        },
        "ats": {
          "description": "Required unless jobKey is given. The applicant-tracking system hosting the board: \"greenhouse\" | \"lever\" | \"ashby\" | \"personio\" | \"pinpoint\" | \"gem\" (the first part of job_key). Example: \"greenhouse\"",
          "type": "string",
          "enum": [
            "greenhouse",
            "lever",
            "ashby",
            "personio",
            "pinpoint",
            "gem"
          ]
        },
        "slug": {
          "description": "Required unless jobKey is given. Board slug from the public board URL (boards.greenhouse.io/{slug}, jobs.lever.co/{slug}, jobs.ashbyhq.com/{slug}, or the Personio account, Pinpoint subdomain or Gem vanity; the middle part of job_key), case-insensitive, 1-100 chars: a letter or digit, then letters, digits, \".\", \"_\" or \"-\". A Personio account, Pinpoint subdomain or Gem vanity cannot contain a dot. Example: \"stripe\"",
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$"
        },
        "jobId": {
          "description": "Required unless jobKey is given. The ATS job id (job_id field, the last part of job_key), 1-100 chars: numeric on Greenhouse and Personio, a UUID on Lever and Ashby, the posting id on Pinpoint, the job post id on Gem. Example: \"8172503\"",
          "type": "string",
          "minLength": 1,
          "maxLength": 100
        },
        "includeDescription": {
          "description": "Optional boolean, default false. true adds job: the full job row (title, location, compensation, posted_at, description_text, ...) when the job is open. On Pinpoint and Gem, description_text stays empty. Example: true",
          "type": "boolean"
        }
      }
    }
  },
  {
    "name": "jobs_get_job",
    "title": "Get one published job's full detail (free)",
    "description": "WHAT: Fetch the full detail of ONE job that is currently published on its official public ATS API (Greenhouse, Lever or Ashby), a Personio or Pinpoint feed, or a named Gem job board, normalized the same way as a board listing.\nWHEN: You already have a job_key, or ats + slug + jobId, from jobs_get_board or a board link and need that single job's text, location, compensation and dates. On Gem the row links to jobs.gem.com and does not include the ad body.\nWHEN NOT: Open or closed only (jobs_check_open). Every opening on a board (jobs_get_board). Jobs in a place across the starter list with no company name (jobs_search_by_location). Many companies, history or repost signals (jobs_search_companies, paid). SmartRecruiters, LinkedIn, Workday, Workable, Recruitee and Rippling are not supported and never contacted.\nBEHAVIOR: Runs on this Fairquery-hosted Worker (Cloudflare), not on the caller's machine; inputs leave the client. This Worker's code is designed not to store inputs or results. The job id and board slug are sent to the public ATS host in the requests below. Greenhouse and Lever: one GET to the documented per-job endpoint (the description is in that response). Ashby, Personio, Pinpoint and Gem have no per-job read here: the documented board feed is fetched once and the id is looked up. Personio is robots.txt then /xml. Pinpoint is robots.txt then /postings.json. Gem is GET /job_posts/ only. Pinpoint and Gem description_text stay empty. No apply URL is requested. HTTP 404/410 on Greenhouse or Lever, when the board itself exists, or an id missing from an Ashby, Personio, Pinpoint or Gem board, is JOB_CLOSED (closed or unknown id) with no partial row. Nothing is stored. Any HTTP 403/429 stops that host for the session (kill switch, HOST_BLOCKED). Lever requests are spaced 1 s apart. Personio accounts share one lane, at least 1.5 s apart. Each Pinpoint subdomain is at least 1 s apart. Gem vanities share one lane, at least 1 s apart.\nCOST: No APIFY_TOKEN, no billing.\nRETURNS: One \"job\" row, or a tool error: INVALID_INPUT, BOARD_NOT_FOUND, JOB_CLOSED, HOST_BLOCKED or NETWORK_ERROR (the last two retryable). A non-JSON body or other HTTP failure uses the ATS client code (ATS_BAD_RESPONSE, ATS_HTTP_ERROR).\nPARAMETERS: A malformed jobKey, or neither jobKey nor a complete ats + slug + jobId, returns INVALID_INPUT with no request. An Ashby or Personio id downloads the whole board with descriptions. A Pinpoint or Gem id downloads the board list and still leaves description_text empty. Greenhouse and Lever use the per-job endpoint; a 404 or 410 triggers one extra board request so JOB_CLOSED is told apart from a missing board (BOARD_NOT_FOUND). Where a description is included it is plain text, at most 20,000 characters, with e-mail addresses and phone numbers removed.\nEXAMPLE: {\"jobKey\":\"greenhouse:stripe:8172503\"} -> that Stripe job's row.",
    "inputSchema": {
      "type": "object",
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "properties": {
        "jobKey": {
          "description": "Optional if ats + slug + jobId are given; wins when both are given. The job_key field of a job row, format \"{ats}:{slug}:{job_id}\" with ats in lowercase (greenhouse | lever | ashby | personio | pinpoint | gem); any other shape returns INVALID_INPUT. Examples: \"greenhouse:stripe:8172503\", \"pinpoint:acme:118475\"",
          "type": "string",
          "maxLength": 250
        },
        "ats": {
          "description": "Required unless jobKey is given. The applicant-tracking system hosting the board: \"greenhouse\" | \"lever\" | \"ashby\" | \"personio\" | \"pinpoint\" | \"gem\" (the first part of job_key). Example: \"greenhouse\"",
          "type": "string",
          "enum": [
            "greenhouse",
            "lever",
            "ashby",
            "personio",
            "pinpoint",
            "gem"
          ]
        },
        "slug": {
          "description": "Required unless jobKey is given. Board slug from the public board URL (boards.greenhouse.io/{slug}, jobs.lever.co/{slug}, jobs.ashbyhq.com/{slug}, or the Personio account, Pinpoint subdomain or Gem vanity; the middle part of job_key), case-insensitive, 1-100 chars: a letter or digit, then letters, digits, \".\", \"_\" or \"-\". A named Personio, Pinpoint or Gem slug cannot contain a dot. Example: \"stripe\"",
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$"
        },
        "jobId": {
          "description": "Required unless jobKey is given. The ATS job id (job_id field, the last part of job_key), 1-100 chars: numeric on Greenhouse and Personio, a UUID on Lever and Ashby, the posting id on Pinpoint, the job post id on Gem. Example: \"8172503\"",
          "type": "string",
          "minLength": 1,
          "maxLength": 100
        }
      }
    }
  },
  {
    "name": "jobs_list_seed_boards",
    "title": "List the verified starter boards (free, offline)",
    "description": "WHAT: List the bundled starter list of company job boards that Fairquery verified on their official ATS APIs (company, domain, ats, slug, verified_at, jobs_at_verification).\nWHEN: To pick companies to scan, or to know which names jobs_find_board resolves instantly.\nWHEN NOT: Live jobs on one board (jobs_get_board), a place search across this list (jobs_search_by_location), or companies not in the list (jobs_find_board). The list is a starting point, not a global index of employers.\nBEHAVIOR: Runs on this Fairquery-hosted Worker (Cloudflare), not on the caller's machine; inputs leave the client. This Worker's code is designed not to store inputs or results. No further network call: it reads a static list compiled into this Worker. jobs_at_verification is a snapshot from verified_at and goes stale.\nCOST: No APIFY_TOKEN, no billing.\nRETURNS: Paged \"seed_board\" rows in the fixed bundled order (original boards stay first, so earlier offsets stay put). 135 Greenhouse, Lever and Ashby boards.\nPARAMETERS: ats narrows the list; omit it for the whole starter list (Greenhouse, Lever, Ashby). Personio, Pinpoint and Gem are not in the starter list (named accounts only). meta.by_ats always counts the whole list per ATS and ignores ats, so take paging totals from total. Feed ats + slug of any item straight into jobs_get_board.\nEXAMPLE: {\"ats\":\"lever\"} -> Palantir, Spotify, Zoox, Ro, then more Lever boards.",
    "inputSchema": {
      "type": "object",
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "properties": {
        "ats": {
          "description": "Optional filter: \"greenhouse\" | \"lever\" | \"ashby\" | \"personio\" | \"pinpoint\" | \"gem\"; default all. The starter list has no Personio, Pinpoint or Gem boards",
          "type": "string",
          "enum": [
            "greenhouse",
            "lever",
            "ashby",
            "personio",
            "pinpoint",
            "gem"
          ]
        },
        "limit": {
          "description": "Optional page size, integer 1-500, default 100",
          "type": "integer",
          "minimum": 1,
          "maximum": 500
        },
        "offset": {
          "description": "Optional items to skip, integer >= 0, default 0; pass nextOffset from the previous response",
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        }
      }
    }
  },
  {
    "name": "jobs_search_by_location",
    "title": "Search the starter list by place and role (free, not every employer)",
    "description": "WHAT: Free search of the bundled starter list (135 public Greenhouse, Lever and Ashby boards). Not every employer and not every company. No company name. Live jobs from each board's official public API. Same normalized \"job\" rows as jobs_get_board. One call may cover only part of the list.\nWHEN: The user asks for jobs by place and/or role and does not name a company. Call THIS tool immediately. Do not ask the user for a company. Do not call jobs_get_board or jobs_find_board first. Examples: \"avionics jobs in Baltimore MD\", \"avionics jobs in Costa Mesa\", \"remote RN jobs in PA\", \"nursing jobs in Maryland\". Put the place in locations (Baltimore, Baltimore MD, MD, Maryland, BWI, PA, Costa Mesa) or countries, or set remote to \"only\". Put a skill or role that may not be the job title in descriptionIncludes (avionics, nurse), not in titleIncludes.\nWHEN NOT: The user already named one company or board (jobs_find_board, then jobs_get_board). They want history, closed jobs, reposts, or employers outside this starter list (jobs_search_companies, paid). This tool does not search all companies.\nBEHAVIOR: Runs on this Fairquery-hosted Worker (Cloudflare), not on the caller's machine; inputs leave the client. This Worker's code is designed not to store inputs or results. Each starter-list board slug is sent to its public ATS host. Requires a place signal or it returns INVALID_INPUT and does not fetch: a non-empty locations list, a non-empty countries list, or remote \"only\". Reads starter boards with the same client, kill switch and rate limits as the other free tools (at most 2 requests in flight per host, Lever spaced 1 s apart, up to 4 boards at a time). A board GET that fails before any job is read (network error, timeout, or HTTP 5xx) is retried once after about 300 ms and that retry is named in meta.notes. HTTP 403 and 429 are not retried. A second failure is skipped and named in meta.notes. The retry is skipped when the CPU budget, the wall clock, or the request cap is already spent. Greenhouse matches title and department on the lite list before any body request. A body is a second request to that same host only when a description keyword is still missing from the title and department, or includeDescription needs the text, and the lite list already has a job in the place. A Greenhouse board with more than 1000 jobs does not get a body request (the Anduril body is about 44 MB and does not fit the 128 MB isolate). Those boards are listed in meta.title_only_boards and return title and department matches only. Lever and Ashby descriptions are in the one list response. Each board is read in small slices, one job at a time. Description fields are not copied unless descriptionIncludes or includeDescription needs them. A text field longer than 20,000 characters is cut before matching and named in meta.notes. A board that is still too large is cut off and the scan continues. A missing board (BOARD_NOT_FOUND) is skipped. A board error is skipped and named in meta.notes. HOST_BLOCKED stops that host for the session; other hosts continue. The scan stops early on a 25 second wall clock, on the CPU work budget (12,000 ms estimated, a hard ceiling, 8,000 JSON characters per millisecond plus 0.08 ms per row built, because the hosted Worker clock does not advance during synchronous parsing; Paid Workers default to about 30 seconds of CPU and this soft-stop returns JSON before that; one call does not run unbounded), on a cap of 200 matched rows, or after 300 ATS requests (a hard ceiling: 135 starter boards take one lite request each, plus a Greenhouse body only when a description is still needed and the board has at most 1000 jobs, at most about 223 requests; Paid Workers allow 10,000 subrequests). It returns the jobs already matched (meta.partial true, meta.stop_reason \"time_budget\", \"cpu_budget\", \"row_cap\" or \"subrequest_budget\", meta.cost_usd 0). A scan error still returns that JSON (meta.stop_reason \"error\"); it does not throw a Server error and it does not invent jobs. Nothing is stored. offset pages rows inside this response. It does not continue the board walk. Pass boardCursor from meta.next_board_cursor, with the same place and keywords, to read boards this call did not start. next_board_cursor is null only when every board from the current board_cursor through the end was started, or no boards remain. Do not call again when it is null. A cpu_budget, subrequest_budget, time_budget, or row_cap stop before the end of the list sets it to the next unstarted index. A board error is skipped and named in meta.notes; it does not rewind the cursor behind boards this call already started.\nCOST: No APIFY_TOKEN, no billing. meta.cost_usd is 0.\nRETURNS: Paged \"job\" rows. meta.boards_total, meta.boards_reached (boards this call started), meta.boards_scanned (boards that finished), meta.boards_ok, meta.boards_failed, meta.boards_skipped, meta.jobs_matched, meta.partial, meta.complete, meta.cut, meta.board_cursor, meta.next_board_cursor, meta.notes and meta.cost_usd. meta.stop_reason is set when partial is true. meta.title_only_boards lists Greenhouse boards whose body was skipped. meta.complete is true when this call started every board from board_cursor through the end and did not hit a budget. meta.next_board_cursor is the first starter index this call did not start, or null when nothing is left to resume.  meta.cut is true when coverage is narrower than a full read. When jobs_matched is 0 after at least one board answered, meta.suggestions lists the title and description tokens tried, place aliases that had open roles, a sample of open titles in the requested place with the keyword removed, and a note that this list is not every employer and which ATS are covered. Suggestions are not job listings.\nPARAMETERS: At least one of locations, countries or remote \"only\" is required. There is no company parameter. titleIncludes and titleExcludes are whole words on the title only. descriptionIncludes is whole-word on the title, the department, or the scrubbed description, so \"avionics\" matches an Avionics department or Electrical Technician when the body says avionics. Do not put the same word in both titleIncludes and descriptionIncludes. \"RN\" matches RN, not \"Registered Nurse\". titleRegex is optional. postedWithinDays drops rows with no ATS date. includeDescription adds scrubbed plain text to the rows; descriptionIncludes still matches when it is false and does not add that text. Location terms expand US state names and codes both ways (MD and Maryland, PA and Pennsylvania) and metro aliases (NYC, SF, LA, DC, Tampa Bay, Baltimore / Baltimore MD / BWI). Two-letter codes match as whole tokens. countries stays ISO-2. boardCursor is an index into the starter list, not a row offset.\nEXAMPLE: {\"locations\":[\"Costa Mesa\"],\"descriptionIncludes\":[\"avionics\"]} -> starter-list jobs in Costa Mesa whose title, department or description says avionics. If meta.complete is false and meta.next_board_cursor is a number, call again with the same filters and {\"boardCursor\": that number}. No company.",
    "inputSchema": {
      "type": "object",
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "properties": {
        "titleIncludes": {
          "description": "Optional, 0-50 strings, any-of. Keep titles containing any of these whole words/phrases, case-insensitive. Title only. For a skill that may appear only in the posting, use descriptionIncludes instead. Example: [\"engineer\"]",
          "maxItems": 50,
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1,
            "maxLength": 100
          }
        },
        "titleExcludes": {
          "description": "Optional, 0-50 strings, any-of. Drop titles containing any of these. Example: [\"intern\"]",
          "maxItems": 50,
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1,
            "maxLength": 100
          }
        },
        "descriptionIncludes": {
          "description": "Optional, 0-50 strings, any-of. Whole words matched against the title, the department, or the scrubbed description, case-insensitive, any-of. Use this for a role or skill that may not be the job title (\"avionics\" matches an Avionics department, or Electrical Technician when the body says avionics). Do not also put the same word in titleIncludes. \"RN\" does not match \"Registered Nurse\". Greenhouse checks title and department on the lite list first. The row includes description_text only when includeDescription is true. Example: [\"avionics\"]",
          "maxItems": 50,
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1,
            "maxLength": 100
          }
        },
        "titleRegex": {
          "description": "Optional case-insensitive regular expression the title must match (max 200 characters, no nested quantifiers). Example: \"^senior\\\\b\"",
          "type": "string",
          "minLength": 1,
          "maxLength": 200
        },
        "locations": {
          "description": "Optional, 0-50 strings, any-of. Place names, any-of. US state names and codes match both ways (Baltimore MD, MD, Maryland, FL, Florida). Metro aliases include NYC, SF, LA, DC, Tampa Bay, and Baltimore / BWI. \"remote\" also matches ATS remote flags. At least one of locations, countries or remote \"only\" is required. This tool has no company parameter. Example: [\"Tampa\"]",
          "maxItems": 50,
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1,
            "maxLength": 100
          }
        },
        "countries": {
          "description": "Optional ISO-3166 alpha-2 codes, any-of, case-insensitive. Counts as a place signal. Example: [\"US\"]",
          "maxItems": 50,
          "type": "array",
          "items": {
            "type": "string",
            "pattern": "^[A-Za-z]{2}$"
          }
        },
        "remote": {
          "description": "Optional, \"any\" | \"only\" | \"exclude\", default \"any\". \"only\" is a place signal and keeps remote jobs. \"exclude\" alone does not start a scan.",
          "type": "string",
          "enum": [
            "any",
            "only",
            "exclude"
          ]
        },
        "postedWithinDays": {
          "description": "Optional integer 1-3650: keep jobs whose ATS publish date is at most this many days old. Example: 14",
          "type": "integer",
          "minimum": 1,
          "maximum": 3650
        },
        "longOpenDays": {
          "description": "Optional integer, default 60: rows older than this get long_open = true (a heuristic, not proof of a ghost job)",
          "type": "integer",
          "minimum": 1,
          "maximum": 3650
        },
        "includeDescription": {
          "description": "Optional boolean, default false. true adds description_text (plain text, <= 20,000 chars, e-mails/phones removed)",
          "type": "boolean"
        },
        "limit": {
          "description": "Optional page size, integer 1-500, default 50",
          "type": "integer",
          "minimum": 1,
          "maximum": 500
        },
        "offset": {
          "description": "Optional items to skip, integer >= 0, default 0; pass nextOffset from the previous response",
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "boardCursor": {
          "description": "Optional index into the starter list, integer >= 0, default 0. Pass meta.next_board_cursor from the previous response, with the same place and keywords, to continue boards that call did not start. This is not the row offset.",
          "type": "integer",
          "minimum": 0,
          "maximum": 10000
        }
      }
    }
  },
  {
    "name": "jobs_search_companies",
    "title": "Search and monitor jobs across many companies (paid Apify Actor)",
    "description": "WHAT: Run the Fairquery Apify Actor fairquery/company-jobs-feed over many companies or boards: board discovery for Greenhouse, Lever and Ashby, a Personio, Pinpoint or Gem feed when you name it, search filters, per-board history (first_seen/last_seen, new/updated/closed, repost detection), optional per-job re-checks and descriptions.\nWHEN: Monitoring a company list (\"what is new since yesterday?\"), searching the verified starter list, or anything that needs history, closed/repost signals or more than a few boards.\nWHEN NOT: One board right now (jobs_get_board). A place or role search of the starter list with no company name and no history (jobs_search_by_location — call that first; do not ask for a company). One job's full detail (jobs_get_job), or one open/closed re-check (jobs_check_open).\nBEHAVIOR: Read-only on job sites; requires APIFY_TOKEN. Called from this Fairquery-hosted Worker, which forwards your input and token to Apify and waits 20 s (APIFY_TIMEOUT if the run has not finished). The Actor runs in YOUR Apify account; history is kept in a named key-value store there. This Worker's code is designed not to store the input or token. Same politeness rules as the free jobs tools: documented ATS APIs only, Personio only at https://{account}.jobs.personio.de/xml after robots.txt, Pinpoint only at https://{subdomain}.pinpointhq.com/postings.json after robots.txt, Gem only at https://api.gem.com/job_board/v0/{vanity}/job_posts/ with no API key, 403/429 kill switch, robots.txt on careers pages. Personio, Pinpoint and Gem are not discovered. Pinpoint and Gem rows link out and do not copy the ad body. Output is that run's rows, not a public jobs directory.\nCOST: Paid, pay-per-event, billed to your Apify account: $0.99 per 1,000 jobs + $0.50 per 1,000 boards, plus optional $0.29 per 1,000 re-checks (confirmOpen) and $1.90 per 1,000 discovered companies; no start fee. Error, closed and merged rows are free. Example: 3 boards, 300 jobs = about $0.30.\nRETURNS: Paged dataset rows: \"job\" rows (as jobs_get_board plus first_seen_at, last_seen_at, change, reposted, repost_of, stale_signal, duplicate_of), one \"board\" row per board (jobs_total, new, updated, closed), \"company\" rows for discovery, \"error\" rows (code, message, retryable).\nPARAMETERS: companies, boards and useSeedList: at least one is required although the schema marks all optional (none -> INPUT_EMPTY, not billed). onlyNew implies history and compares with the last run that used the same stateStoreName, so use one name per saved search; the first run returns everything as new. limit/offset page the returned rows on this Worker; every call starts a new billed run, so fetch the pages you need from one result instead of re-calling.\nEXAMPLE: {\"companies\":[\"stripe.com\",\"ramp.com\"],\"titleIncludes\":[\"engineer\"],\"countries\":[\"US\"],\"onlyNew\":true}.",
    "inputSchema": {
      "type": "object",
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "properties": {
        "companies": {
          "description": "Optional (see PARAMETERS). 0-200 names, domains or board URLs. Example: [\"stripe.com\",\"Ramp\",\"https://jobs.lever.co/palantir\"]",
          "maxItems": 200,
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 2,
            "maxLength": 300
          }
        },
        "boards": {
          "description": "Optional. 0-500 exact boards. Example: [{\"ats\":\"lever\",\"slug\":\"palantir\"}]",
          "maxItems": 500,
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "ats": {
                "type": "string",
                "enum": [
                  "greenhouse",
                  "lever",
                  "ashby",
                  "personio",
                  "pinpoint",
                  "gem"
                ],
                "description": "Required. The applicant-tracking system hosting the board: \"greenhouse\" | \"lever\" | \"ashby\" | \"personio\" | \"pinpoint\" | \"gem\". Personio, Pinpoint and Gem are the account, subdomain or vanity you name, not a discovered board. Example: \"ashby\""
              },
              "slug": {
                "type": "string",
                "pattern": "^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$",
                "description": "Required. Board slug as it appears in the public board URL (case-insensitive): boards.greenhouse.io/{slug}, jobs.lever.co/{slug}, jobs.ashbyhq.com/{slug}, the Personio account in {account}.jobs.personio.de, the Pinpoint subdomain in {subdomain}.pinpointhq.com, or the Gem vanity in jobs.gem.com/{vanity}. Named feeds reject a dot. 1-100 chars. Example: \"ramp\" or \"acme\""
              },
              "company": {
                "description": "Optional display name",
                "type": "string",
                "maxLength": 200
              }
            },
            "required": [
              "ats",
              "slug"
            ]
          }
        },
        "useSeedList": {
          "description": "Optional boolean, default false: also scan all verified starter boards (each billed as a board)",
          "type": "boolean"
        },
        "titleIncludes": {
          "description": "Optional, 0-50 strings, any-of. Whole-word title match. Example: [\"engineer\"]",
          "maxItems": 50,
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1,
            "maxLength": 100
          }
        },
        "titleExcludes": {
          "description": "Optional, 0-50 strings, any-of. Whole-word title exclusion. Example: [\"intern\"]",
          "maxItems": 50,
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1,
            "maxLength": 100
          }
        },
        "locations": {
          "description": "Optional, 0-50 strings, any-of. Location substring match. US state names and codes match both ways; NYC, SF, LA, DC and Tampa Bay metro aliases match. Example: [\"london\"]",
          "maxItems": 50,
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1,
            "maxLength": 100
          }
        },
        "countries": {
          "description": "Optional ISO-2 codes, any-of. Example: [\"US\",\"GB\"]",
          "maxItems": 50,
          "type": "array",
          "items": {
            "type": "string",
            "pattern": "^[A-Za-z]{2}$"
          }
        },
        "remote": {
          "description": "Optional, \"any\" | \"only\" | \"exclude\", default \"any\" (no remote filter). \"only\" keeps job rows with remote = true (an ATS remote flag, or remote wording such as \"Remote\" or \"Anywhere\" in the location or title; see remote_basis); \"exclude\" drops those rows and keeps rows where remote is false or unknown (null)",
          "type": "string",
          "enum": [
            "any",
            "only",
            "exclude"
          ]
        },
        "departments": {
          "description": "Optional, 0-50 strings, any-of. Department/team substring match. Example: [\"engineering\"]",
          "maxItems": 50,
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1,
            "maxLength": 100
          }
        },
        "postedWithinDays": {
          "description": "Optional integer 1-3650, default off: keep only job rows whose ATS publish date (posted_at) is at most this many whole days old; rows without an ATS publish date (posted_at = null) are dropped. Free closed rows are not filtered by it. Example: 7",
          "type": "integer",
          "minimum": 1,
          "maximum": 3650
        },
        "excludeStale": {
          "description": "Optional boolean, default false. true drops job rows with long_open = true (age_days > 60, counted from posted_at, or from first_seen_at when the ATS gives no date) or reposted = true (a new job id matching a job that closed on the same board within 90 days, from the history in stateStoreName, so never on a board's first tracked run). Free closed rows are not filtered by it",
          "type": "boolean"
        },
        "onlyNew": {
          "description": "Optional boolean, default false: only new/changed jobs since the last tracked run (plus free closed rows)",
          "type": "boolean"
        },
        "stateStoreName": {
          "description": "Optional, default \"fairquery-jobs-feed-state\": named key-value store for history in your Apify account",
          "type": "string",
          "pattern": "^[a-zA-Z0-9-]{3,63}$"
        },
        "confirmOpen": {
          "description": "Optional boolean, default false: re-check each emitted job on its detail endpoint ($0.29 per 1,000 re-checks, max 200 per run)",
          "type": "boolean"
        },
        "includeDescription": {
          "description": "Optional boolean, default false: add plain-text descriptions (PII-scrubbed)",
          "type": "boolean"
        },
        "maxJobs": {
          "description": "Optional integer 1-50000, default 5000: spend cap on billed job rows",
          "type": "integer",
          "minimum": 1,
          "maximum": 50000
        },
        "limit": {
          "description": "Optional page size, integer 1-500, default 50",
          "type": "integer",
          "minimum": 1,
          "maximum": 500
        },
        "offset": {
          "description": "Optional items to skip, integer >= 0, default 0; pass nextOffset from the previous response",
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        }
      }
    }
  }
];

export const TOOL_NAMES = TOOL_DEFS.map((t) => t.name);

/** Whether `name` is one of the captured tools. */
export function isKnownTool(name: string): boolean {
  return TOOL_NAMES.includes(name);
}

/* ------------------------------------------------------------------ */
/* Forwarding client                                                   */
/* ------------------------------------------------------------------ */

function errorResult(detail: string): ToolResult {
  return {
    content: [{ type: "text", text: `jobfeed error: ${detail}` }],
    isError: true,
  };
}

function rpcErrorMessage(error: unknown): string {
  if (error !== null && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message !== "") return message;
    return JSON.stringify(error);
  }
  return String(error);
}

/**
 * Parse a JSON-RPC response body, tolerating SSE framing.
 * Returns the message whose id matches `expectedId` when
 * one is present, else the last parseable message, else
 * null when nothing parses.
 */
export function parseRpcBody(
  text: string,
  expectedId?: number,
): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const candidates: Record<string, unknown>[] = [];
  const tryPush = (payload: string): void => {
    try {
      const parsed: unknown = JSON.parse(payload);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        candidates.push(parsed as Record<string, unknown>);
      }
    } catch {
      // Not JSON; ignore this candidate.
    }
  };
  if (trimmed.includes("data:")) {
    for (const line of trimmed.split("\n")) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const payload = t.slice("data:".length).trim();
      if (payload !== "" && payload !== "[DONE]") tryPush(payload);
    }
  } else {
    tryPush(trimmed);
  }
  if (candidates.length === 0) return null;
  if (expectedId !== undefined) {
    const match = candidates.find((c) => c.id === expectedId);
    if (match !== undefined) return match;
  }
  return candidates[candidates.length - 1];
}

async function defaultFetch(
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
): Promise<FetchResponseLike> {
  return fetch(url, init) as unknown as FetchResponseLike;
}

/**
 * A forwarding client holding one upstream session. The
 * session is established lazily on the first forwarded
 * call and reused for the lifetime of the client (the
 * process lifetime when the client is the MCP server's
 * or a one-shot client for the CLI).
 */
export class JobfeedClient {
  private readonly deps: ForwardDeps;
  private sessionId: string | null = null;
  private ready = false;
  private sessionPromise: Promise<void> | null = null;
  private idCounter = 0;

  constructor(deps: ForwardDeps = {}) {
    this.deps = deps;
  }

  private fetchFn(): FetchFn {
    return this.deps.fetchFn ?? defaultFetch;
  }

  private endpointUrl(): string {
    if (this.deps.url && this.deps.url.trim() !== "") return this.deps.url.trim();
    const raw = (this.deps.env ?? process.env).FAIRQUERY_JOBS_MCP_URL;
    if (raw && raw.trim() !== "") return raw.trim();
    return DEFAULT_ENDPOINT_URL;
  }

  private apiKey(): string | null {
    const raw = (this.deps.env ?? process.env).FAIRQUERY_JOBS_API_KEY;
    if (raw && raw.trim() !== "") return raw.trim();
    return null;
  }

  private timeoutMs(): number {
    if (typeof this.deps.timeoutMs === "number" && this.deps.timeoutMs > 0) {
      return this.deps.timeoutMs;
    }
    return DEFAULT_TIMEOUT_MS;
  }

  private nextId(): number {
    this.idCounter += 1;
    return this.idCounter;
  }

  private async post(
    body: unknown,
    withSession: boolean,
  ): Promise<FetchResponseLike> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    const key = this.apiKey();
    if (key !== null) headers["Authorization"] = `Bearer ${key}`;
    if (withSession && this.sessionId !== null) {
      headers["Mcp-Session-Id"] = this.sessionId;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs());
    try {
      return await this.fetchFn()(this.endpointUrl(), {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private async ensureSession(): Promise<void> {
    if (this.ready) return;
    if (this.sessionPromise === null) {
      this.sessionPromise = (async () => {
        const initId = this.nextId();
        const initRes = await this.post(
          {
            jsonrpc: "2.0",
            id: initId,
            method: "initialize",
            params: {
              protocolVersion: PROTOCOL_VERSION,
              capabilities: {},
              clientInfo: { name: "jobfeed", version: VERSION },
            },
          },
          false,
        );
        const sessionId = initRes.headers.get("mcp-session-id");
        if (sessionId) this.sessionId = sessionId;
        const initText = await initRes.text();
        const initParsed = parseRpcBody(initText, initId);
        if (initParsed !== null && initParsed.error) {
          throw new Error(rpcErrorMessage(initParsed.error));
        }
        if (initRes.status < 200 || initRes.status >= 300) {
          throw new Error(`HTTP ${initRes.status}`);
        }
        if (initParsed === null && initText.trim() !== "") {
          throw new Error("malformed response");
        }
        const initializedRes = await this.post(
          { jsonrpc: "2.0", method: "notifications/initialized" },
          true,
        );
        try {
          await initializedRes.text();
        } catch {
          // The notification response body carries nothing we need.
        }
        this.ready = true;
      })();
    }
    try {
      await this.sessionPromise;
    } catch (err) {
      this.sessionPromise = null;
      this.sessionId = null;
      throw err;
    }
  }

  /** Forward one tool call; upstream failures come back as isError results. */
  async callTool(name: string, args: ToolArgs): Promise<ToolResult> {
    try {
      await this.ensureSession();
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }

    const callId = this.nextId();
    let callRes: FetchResponseLike;
    try {
      callRes = await this.post(
        {
          jsonrpc: "2.0",
          id: callId,
          method: "tools/call",
          params: { name, arguments: args ?? {} },
        },
        true,
      );
    } catch (err) {
      return errorResult(
        `request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const parsed = parseRpcBody(await callRes.text(), callId);
    if (parsed !== null && parsed.error) {
      return errorResult(rpcErrorMessage(parsed.error));
    }
    if (callRes.status < 200 || callRes.status >= 300) {
      return errorResult(`HTTP ${callRes.status}`);
    }
    if (parsed === null) return errorResult("malformed response");
    const result = parsed.result as ToolResult | undefined;
    if (result === undefined || result === null || typeof result !== "object") {
      return errorResult("malformed response");
    }
    // Pass the upstream result through verbatim.
    return result;
  }
}

/** Create a forwarding client; tests inject a fake fetch and env through deps. */
export function createClient(deps: ForwardDeps = {}): JobfeedClient {
  return new JobfeedClient(deps);
}

/** One-shot helper: a fresh client per call (the CLI path). */
export async function callTool(
  name: string,
  args: ToolArgs,
  deps: ForwardDeps = {},
): Promise<ToolResult> {
  return new JobfeedClient(deps).callTool(name, args);
}
