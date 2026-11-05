# M365 Upstream

Second upstream provider: the Microsoft 365 Copilot coding-agent gateway. The
default endpoint is `https://df.loki.delve.office.com/api/v1/llmapi`;
`https://msit.loki.delve.office.com/api/v1/llmapi` remains a built-in option.
It speaks the Anthropic Messages protocol directly, so the request path reuses
`native-messages` without translation.

The dated live catalog, model, and limit observations below were measured on
`msit.loki`; they do not establish connectivity or access on `df.loki` or a
custom gateway.

M365 is a **route target** beside the GitHub accounts, not a process-wide mode.
A hostname mapping registers it (`accountRouting.hostnames`), a request's
hostname selects it, and one process can serve both upstreams on one listener.
`--upstream m365` remains as a shorthand for a routing table that holds only
this target; in that mode the listener still binds `127.0.0.1`.

## Gateway endpoint selection

In Dashboard **Accounts → M365 Copilot target**, select an **Upstream endpoint**
and click **Use endpoint**, or enter a **Custom HTTPS endpoint** and click
**Add and use endpoint**. Endpoint settings can be saved before adding the
M365 target. They are distinct from the local routing hostname and client base
URL.

`config.json#m365.endpoint` stores the selected gateway;
`config.json#m365.endpoints` stores additional saved choices. Omission of
`endpoint` selects `df.loki`, including for existing configurations that only
select a broker account. Example:

```json
{
  "m365": {
    "account": "uid.utid",
    "endpoint": "https://gateway.example.com/api/v1/llmapi",
    "endpoints": ["https://gateway.example.com/api/v1/llmapi"]
  }
}
```

Endpoints must be HTTPS base URLs without embedded credentials, query strings,
or fragments. Whitespace and trailing slashes are normalized; saved choices
are deduplicated. Invalid saved M365 settings fail startup rather than silently
selecting another gateway. Only select trusted endpoints: the Microsoft access
token is sent to the selected address.

Startup catalog discovery, Dashboard model refresh, and Messages requests use
the same target endpoint. Changing it persists settings, replaces the target
runtime, and loads its catalog; in-flight requests retain their previous
runtime. Endpoint choices survive broker-account/hostname changes and removal
of the proxy target. There is no automatic endpoint failover.

Dashboard endpoint saves and target registration are mutually exclusive.
Journal rollback restores the previously committed in-memory configuration as
well as the disk state; a failed update does not discard saved choices.

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

- The M365 target does not use a GitHub credential, and its model discovery
  never targets GitHub. Mixed routing retains the normal account manager.
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
caches the `/v1/messages` subset. On 2026-11-03 a live GET returned 200 and ten
entries: five Anthropic Messages models and five GPT Responses models. The
proxy's M365 target supports Messages inference only, so `GET /models` and
`GET /v1/models` on its hostname expose the five supported models rather than
advertising unavailable Responses dispatch.

`src/clients/m365-upstream.ts` retains a static catalog for transient discovery
failures. A catalog 401/403 is an authorization failure, not a discovery outage:
initialization and later metadata refreshes retain `unavailable` and ask the
operator to select an account with gateway access and a Copilot subscription.

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

Every entry in the proxy's supported M365 catalog advertises `/v1/messages`.
That keeps `resolveMessagesStrategyName()` on `native-messages`. The upstream's
Responses models are filtered out because this target does not yet admit
Responses or Chat Completions inference.

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
- Precedence: `--msc-auth-account` → `config.json#m365.account` →
  `config.json#m365.upn` → a unique broker account in the authority tenant, or
  the only broker account. There is no hard-coded email or substring fallback;
  an ambiguous selector requires a home account ID.
- The Dashboard displays the selected email and Microsoft tenant ID instead of
  a GitHub tenant. It discovers broker accounts on the first Accounts visit and
  on explicit probes, not on every Live poll. Empty broker usernames retain
  their stable IDs and display as unavailable rather than shifting TSV columns.
- `GET /dashboard/api/m365` reads the committed routing table, availability,
  and selected/available gateway endpoints. `/register`, `/remove`, `/account`,
  `/hostname`, and `/endpoint` mutations use the account manager.
  `POST /dashboard/api/m365/endpoint` accepts `{ "endpoint": "https://…",
  "endpoints": ["https://…"] }`; `endpoints` is optional. Endpoint settings
  are persisted through the account-management journal, preserving omitted
  broker settings. `POST /dashboard/api/m365/sign-in` opens WAM only on an
  explicit user action, returns identity fields without tokens, and leaves
  target selection unchanged until applied. Copilot app profiles absent from
  WAM need this sign-in; listing accounts is not proof of subscription access.
- `DELETE /dashboard/api/accounts/:accountName` removes a non-default proxy
  account or target; the sole remaining target cannot be removed. Removing M365
  does not remove a Windows/WAM account.
- The target name `m365` is reserved: routing rejects a GitHub account that
  claims it, and credential creation refuses to write it.
- `msc-auth --accounts` lists `upn<TAB>homeAccountId<TAB>environment`.
  `msc-auth --account <homeAccountId-or-exact-email>` selects it from a shell;
  duplicate email matches require the home ID.

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
bun run start --upstream m365 --msc-auth-account you@company.com --port 4199
curl -s http://127.0.0.1:4199/v1/models
```

On Windows, source `start` prepares the native helper before the CLI loads.
Local compilation requires the .NET 10 SDK, C++ tools, and Windows SDK; a complete
explicit helper or `MSC_AUTH_DIR` prebuilt payload avoids that toolchain.

Expected: five models listed (the catalog's `/v1/messages` subset; the gateway
also serves five `gpt-*` models on `/responses`), `POST /v1/messages` returns
`200`, streaming returns Anthropic SSE, and the listener binds `127.0.0.1` only.
