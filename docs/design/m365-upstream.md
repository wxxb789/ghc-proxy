# M365 Upstream (`--upstream m365`)

Second upstream provider: the Microsoft 365 Copilot coding-agent gateway at
`https://msit.loki.delve.office.com/api/v1/llmapi`. It speaks the Anthropic
Messages protocol directly, so the request path reuses `native-messages` without
translation.

Selected with `--upstream m365`. The GitHub path is the default and is unchanged.

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

## Static catalog

The gateway has no `/models` endpoint (`404 NonExistentApi`) and rejects unknown
names with `403 model_not_allowed`, so `src/clients/m365-upstream.ts` carries the
catalog. Only names verified against the live gateway are listed:

| Model | `/v1/messages` | Streaming | Tool calls |
| --- | --- | --- | --- |
| `claude-opus-5.5` | verified | verified | verified |
| `claude-sonnet-5.5` | verified | — | — |
| `claude-haiku-5.5` | verified | — | — |

Every catalog entry advertises only `/v1/messages`. That keeps
`resolveMessagesStrategyName()` on `native-messages`; the Responses and Chat
Completions strategies must never be selected because the gateway serves neither.

## Header contract

`copilotHeaders()` branches to `m365Headers()` for this upstream, so GitHub
identity headers (`editor-version`, `copilot-integration-id`,
`x-github-api-version`) never reach the gateway. The gateway set is
`Authorization`, `anthropic-version`, `X-ClientType`, `X-ClientFeature`,
`X-ClientScenario`, `X-HostPlatform`, `X-Llm-Api-Version`, and per-request
`X-ConversationId`/`X-ClientCallId`, with `X-Initiator: user` (the combination
verified live).

## Security boundary

The server binds `127.0.0.1` only when this upstream is active. The credential is
the user's own Microsoft account, so exposing the port on a LAN would let any
client spend that account's quota. The GitHub path keeps its existing bind
behavior.

## Known limits

- Account routing, the Dashboard account views, and GHE options are
  GitHub-specific and are not used here.
- Unknown model names are not rejected up front; they fall through to the
  upstream, which answers `400`.
- Request queue, retry, and timeout settings apply unchanged. Only 429 and 529
  are replayed, as for every other completion endpoint.

## Verification

```bash
bun run build:msc-auth            # Windows: publish the helper into dist/msc-auth
bun ./src/main.ts start --upstream m365 --port 4199
curl -s http://127.0.0.1:4199/v1/models
```

Expected: three models listed, `POST /v1/messages` returns `200`, streaming
returns Anthropic SSE, and the listener binds `127.0.0.1` only.
