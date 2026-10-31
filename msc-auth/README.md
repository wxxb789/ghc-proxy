# msc-auth

Minimal credential source for the Microsoft 365 Copilot coding-agent LLM gateway
(`https://msit.loki.delve.office.com/api/v1/llmapi`). It replaces reading JWTs out
of the Copilot process memory: no memory scan, no PEB parsing, and the Copilot app
does not need to be running.

This is an auxiliary binary, not part of the TypeScript build. It is the only
Windows-specific piece in the repository; everything under `src/` stays
runtime-neutral (Bun and Node).

## How it works

The Windows token broker (WAM) already holds the signed-in account and a refresh
token for the client the Copilot app uses. Asking the broker is a supported
Windows API call:

```
ghc-proxy  ->  msc-auth.exe  ->  MSAL 4.92 (BrokerOptions)
                             ->  WAM (TokenBroker)
                             ->  login.microsoftonline.com
```

WAM performs the silent refresh. MSAL keeps nothing on disk here, so the only
credential material is the returned access token, held in memory for its
lifetime.

## Recovered parameters

Read from the app's own WAM request record
(`%LOCALAPPDATA%\Microsoft\TokenBroker\Cache\*.tbres`: DPAPI user scope, no
entropy, UTF-16 JSON envelope with a `WTRes_PropertyBag` payload):

| Parameter | Value |
| --- | --- |
| `client_id` | `0ec893e0-5785-4de6-99da-4ed124e5296c` — "Microsoft 365 Copilot", owner tenant `f8cdef31-a31e-4b4a-93e4-5f571e91255a` |
| scope | `api://42c8f7bd-c7a8-4ba9-bc1c-91edfb716247/.default offline_access openid profile` |
| authority | `https://login.microsoftonline.com/72f988bf-86f1-41af-91ab-2d7cd011db47` |
| redirect URI | `ms-appx-web://Microsoft.AAD.BrokerPlugin/0ec893e0-5785-4de6-99da-4ed124e5296c` |
| broker | WAM (`TokenBroker`) |

The resource is `Microsoft FX Gateway`
(`42c8f7bd-c7a8-4ba9-bc1c-91edfb716247`). Its `LLM.Read` scope is user-consentable,
but the API owner preauthorizes clients, which is why Azure CLI fails with
`AADSTS65002` and this client does not.

## Why the Broker package is required

`Microsoft.Identity.Client` (MSAL.NET) and `Microsoft.Identity.Client.Broker` are the
same SDK: the broker package is the MSAL.NET component that binds it to the Windows
token broker. Measured with MSAL.NET alone (no `.Broker` reference): `GetAccountsAsync`
returns 0 accounts and `AcquireTokenSilent` cannot run, because the account and its
refresh token live in WAM, not in the process.

`msalruntime.dll` is not the SDK. It is `Microsoft.Identity.Client.NativeInterop`
(a dependency of `.Broker`), the native layer that performs the WAM calls. Dropping it
while keeping silent acquisition is not possible; the alternatives are a WinRT
`WebAuthenticationCoreManager` interop written by hand, or an interactive
authorization-code flow, which needs a registered redirect URI and one sign-in per user.

WAM is reached through the AppX broker, so the client registration carries the broker
redirect URI and no loopback entry. Measured: a loopback authorization-code request
(`http://localhost:53682`, PKCE, `prompt=select_account`) completes sign-in and then
fails with `AADSTS50011` - the redirect URI is not configured for `0ec893e0-...`.
There is no non-broker flow, so there is no `msal-node` or other cross-platform path
to this token; the device-code grant is disabled by tenant policy as well.

## Build

```bash
dotnet build msc-auth                                   # JIT
dotnet publish msc-auth -c Release -r win-x64 -p:PublishAot=true -o dist/msc-auth
```

What matters is the Windows TFM (`10.0.19041.0`), not the runtime major version:

| Configuration | Result |
| --- | --- |
| `net8.0-windows10.0.17763.0` | builds, broker does not engage as expected |
| `net8.0-windows10.0.19041.0` | verified |
| `net10.0-windows10.0.19041.0` | verified — MSAL 4.92 on .NET 10.0.14 |
| `net10.0` + `PublishAot` | verified, 9.1 MB exe |

Two things break under AOT, both already handled:

- Reflection-based `JsonSerializer.Serialize` (`IL3050`) throws in a native
  image. Serialization goes through a source-generated `JsonSerializerContext`.
- `[LibraryImport]` forces `AllowUnsafeBlocks`; `[DllImport]` with a blittable
  signature does not.

The publish output is `msc-auth.exe` plus `msalruntime.dll` (MSAL's WAM native
runtime). It is not a single file, and it is win-x64 only.

## Usage

```
msc-auth --json          # { access_token, expires_on, tenant, username, scopes }
msc-auth                 # access token only
msc-auth --accounts      # list broker accounts (username, home id, environment)
msc-auth --account <id>  # pick the account by home account id (unambiguous)
msc-auth --upn <upn>     # pick the account (default: lhan@microsoft.com)
msc-auth --tenant <tid>  # pick the authority tenant
msc-auth --interactive   # sign in through WAM, even when an account is already selected
msc-auth --verbose       # MSAL diagnostics on stderr
```

Exit codes: `0` success, `2` no account selected or interaction required,
`3` broker/MSAL failure. Diagnostics go to stderr; stdout carries only the
payload.

The default account is `lhan@microsoft.com` (the subscription account). Consumer
accounts (MSA) are **out of scope**: the broker lists them, but acquiring a
gateway token for one fails with `unknown_broker_error` (`0x80070057`) and no
support is planned. Use `--accounts` to confirm which entry you are pointing at.

## Verified models

`GET /api/v1/llmapi/models` returns the served catalog (query parameters are
ignored). The table below records the per-name checks that preceded it and still
constrain the proxy's own fallback list:

| Model | Non-stream | Stream |
| --- | --- | --- |
| `claude-opus-5.5` | 200, `end_turn` | 200, `text/event-stream`, Anthropic SSE |
| `claude-opus-5` | 200, `end_turn` | — |
| `claude-sonnet-5.5` | 200, `end_turn` | — |
| `claude-sonnet-5` | 200, `end_turn` | — |
| `claude-haiku-5.5` | 200, `end_turn` | — |
| `claude-opus-4.6` / `4.7` / `4.8`, `claude-sonnet-4.6`, `claude-haiku-4.5`, `claude-sonnet-4-5-20250929` | 403 `model_not_allowed` | — |

`GET /api/v1/llmapi/models` lists the whole catalog (query parameters are
ignored); it reports `max_context_window_tokens: 1000000` for every Anthropic
model. Limits, measured by bisection because the gateway reports only
`invalid_body`:
`max_tokens` 128,000 is accepted and 128,001 is rejected; a 546,008 input-token
request succeeds, so the context window is at least 546k and its real ceiling is
unknown.

## Shipping in the npm package

The npm artifact may carry the publish output; `package.json#files` includes
`dist/msc-auth/**` and `bun run build:msc-auth` produces it. Constraints:

- Build on Windows only. The release workflow currently runs on `ubuntu-latest`,
  so it must publish the helper from a Windows job (or download a prebuilt
  artifact) before `npm publish`; otherwise the directory is simply absent from
  the tarball.
- `msalruntime.dll` is a Microsoft redistributable. Its license terms and the
  `THIRD_PARTY_NOTICES.md` entry have to be checked before publishing it.
- Every platform downloads the win-x64 payload (~12 MB). Accept that, or move the
  helper into a platform-gated `optionalDependencies` package later.
- Do not commit `bin/`, `obj/`, or `out/`; the binary is built, not stored.

## Caveats

- Windows only. Without WAM there is no credential path, so on other platforms
  the provider must report "unavailable" rather than fall back.
- A fresh machine needs one `--interactive` sign-in to establish the WAM session.
- The token is issued to the user, but `azp=0ec893e0-...` identifies the Copilot
  client in every audit record. That is a terms-of-service question, not a
  technical limitation.
