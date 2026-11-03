# M365 Upstream

Second upstream provider: the Microsoft 365 Copilot coding-agent gateway at
`https://msit.loki.delve.office.com/api/v1/llmapi`. It speaks the Anthropic
Messages protocol directly, so the request path reuses `native-messages` without
translation.

M365 is a **route target** beside the GitHub accounts, not a process-wide mode.
A hostname mapping registers it (`accountRouting.hostnames`), a request's
hostname selects it, and one process can serve both upstreams on one listener.
`--upstream m365` remains as a shorthand for a routing table that holds only
this target; in that mode the listener still binds `127.0.0.1`.

## Credential path

`src/clients/msc-auth.ts` shells out to the `msc-auth` helper (`msc-auth/` in this
repository), which obtains a delegated token from the Windows token broker (WAM)
through MSAL. The helper is the only Windows-specific component; `src/` stays
runtime-neutral and talks to it over stdout JSON.

| Property | Value |
| --- | --- |
| Client | `0ec893e0-5785-4de6-99da-4ed124e5296c` (Microsoft 365 Copilot) |
| Scope | `api://42c8f7bd-c7a8-4ba9-bc1c-91edfb716247/.default` — `Microsoft FX Gateway` |
| Lifetime | ~70 minutes; re-acquired 5 minutes before expiry, single-flight |

Consequences:

- No GitHub credential is read, no account manager is created, and `/models` is
  never fetched from GitHub.
- The access token lives only in memory. Nothing is written to disk.
- Windows is mandatory: there is no non-broker flow for this client (a loopback
  PKCE attempt fails with `AADSTS50011`, and the device-code grant is disabled by
  tenant policy). MSAL is not a cross-platform route here.

## Catalog

`GET /api/v1/llmapi/models` exists (the earlier `404` came from probing
`/v1/models`) and returns every model the gateway serves: five Anthropic entries on
`/v1/messages` and five `gpt-*` entries on `/responses`. Query parameters
(`keyword`, `q`, `search`, `filter`, `publisher`, `supported_endpoints`, `limit`,
`$top`) are ignored — the response is identical — so discovery means fetching the
whole list and filtering locally.

At startup the proxy fetches that endpoint with the freshly acquired token and
caches the `/v1/messages` subset, so context limits come from the gateway itself
(1,000,000 today). Unknown names still return `403 model_not_allowed`.

`src/clients/m365-upstream.ts` keeps a static list for the case where the catalog
request fails; it is a fallback, not the source of truth:

| Model | Status |
| --- | --- |
| `claude-opus-5.5` | 200 — streaming and tool calls verified |
| `claude-opus-5` | 200 |
| `claude-sonnet-5.5` | 200 |
| `claude-sonnet-5` | 200 |
| `claude-haiku-5.5` | 200 |

`claude-opus-4.8`, `claude-opus-4.7`, `claude-opus-4.6`, `claude-sonnet-4.6`,
`claude-haiku-4.5`, and `claude-sonnet-4-5-20250929` return
`403 model_not_allowed`. The host offers those older names in its own picker, so
the service-side allow-list is narrower than the client-side list.

Every catalog entry advertises only `/v1/messages`. That keeps
`resolveMessagesStrategyName()` on `native-messages`; the Responses and Chat
Completions strategies must never be selected because the gateway serves neither.

## Measured limits

The gateway masks upstream detail (`400 {"code":"invalid_body"}`), so limits are
established by bisection, not read from error text:

- **Output:** `max_tokens: 128000` returns 200, `128001` returns 400 — the
  ceiling is exactly 128k. That value is advertised as `max_output_tokens`.
- **Context:** `GET /api/v1/llmapi/models` reports
  `capabilities.limits.max_context_window_tokens: 1000000` for all five Anthropic
  models, which matches a live 546,008-token request and the accepted
  `context-1m-2025-08-07` beta. The catalog takes the value from the gateway; the
  static fallback carries the same 1,000,000. Models outside the fallback list
  advertise no context limit when the gateway omits one, and consumers treat a
  missing limit as "do not clamp".

## Account selection

The Windows broker usually exposes every signed-in work account, but only some
carry the Copilot subscription that can mint gateway tokens. A consumer account
(for example an MSA) fails at acquisition with a broker error (`0x80070057`)
rather than an HTTP error.

Consumer accounts are **out of scope**: the picker lists whatever the broker
returns so the operator can see why an account cannot be used, but no path is
planned for minting gateway tokens for an MSA.

- `config.json#m365.account` stores the broker **home account id**
  (`uid.utid`), which stays unambiguous when one UPN exists in several tenants.
- Precedence: `--msc-auth-account` → `config.json#m365.account` → the helper's
  default (`lhan@microsoft.com`, then `--prefer`).
- The Dashboard's Accounts view shows the target in both states. `GET
  /dashboard/api/m365` projects the committed routing table and availability;
  `POST /dashboard/api/m365/register`, `/remove`, `/account`, and `/hostname`
  run through the account manager's transaction, and `POST
  /dashboard/api/m365/probe` is the only call that lists broker accounts.
  Registration, removal, and identity changes apply without a restart.
- The target name `m365` is reserved: routing rejects a GitHub account that
  claims it, and credential creation refuses to write it.
- `msc-auth --accounts` lists `upn<TAB>homeAccountId<TAB>environment`, and
  `msc-auth --account <homeAccountId>` reproduces the selection from a shell.

## Family fallbacks

Unadvertised `claude-<family>-*` ids are mapped onto the catalog at rewrite time
(`rewriteModel` step 3), before model selection, so the request never falls
through to a strategy the gateway cannot serve. `M365_FALLBACKS` is the single
source and every target is a catalog member:

| Request family | Target |
| --- | --- |
| `claude-opus-*` | `claude-opus-5.5` |
| `claude-sonnet-*` | `claude-sonnet-5.5` |
| `claude-haiku-*` | `claude-haiku-5.5` |

Verified through the proxy: `claude-opus-4.6`, `claude-sonnet-4-5-20250929`, and
`claude-haiku-4.5` are served by the 5.5 models and return `200`.

## Header contract

`copilotHeaders()` branches to `m365Headers()` for this upstream, so GitHub
identity headers (`editor-version`, `copilot-integration-id`,
`x-github-api-version`) never reach the gateway. The gateway set is
`Authorization`, `anthropic-version`, `X-ClientType`, `X-ClientFeature`,
`X-ClientScenario`, `X-HostPlatform`, `X-Llm-Api-Version`, and per-request
`X-ConversationId`/`X-ClientCallId`, with `X-Initiator: user` (the combination
verified live).

## Security boundary

The credential is the user's own Microsoft account, so the boundary follows the
target rather than the process:

- Requests that select the M365 target are accepted only from a loopback peer;
  a live runtime with no resolvable peer address fails closed.
- The gate keys on the target's upstream, so it also covers the base hostname
  and the `127.0.0.1` alias when the M365 target is the default.
- GitHub targets keep their existing reachability.
- When M365 is the only target (`--upstream m365`), the listener still binds
  `127.0.0.1` only.

An unavailable target answers 503 with its recorded cause; dashboard paths and
the target's own model list are not inference and continue to their own
handlers.

## Known limits

- GitHub account management and GHE options remain GitHub-specific; they are
  not used here.
- Only the Messages endpoint family is served on this target. Chat Completions,
  Responses, and Embeddings requests are refused with an error naming
  `/v1/messages` instead of being forwarded.
- Unknown model names are not rejected up front; the gateway answers
  `403 model_not_allowed`, which the proxy returns unchanged (probed with
  `claude-unknown-1`).
- Request queue, retry, and timeout settings apply unchanged. Only 429 and 529
  are replayed, as for every other completion endpoint.

## Verification

```bash
bun run build:msc-auth            # Windows: publish the helper into dist/msc-auth
bun ./src/main.ts start --upstream m365 --port 4199
curl -s http://127.0.0.1:4199/v1/models
```

Expected: five models listed (the catalog's `/v1/messages` subset; the gateway
also serves five `gpt-*` models on `/responses`), `POST /v1/messages` returns
`200`, streaming returns Anthropic SSE, and the listener binds `127.0.0.1` only.
