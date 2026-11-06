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

## Starting the proxy from source

`bun run start` prepares the helper before loading the source CLI on Windows.
It keeps `NODE_ENV=production` and forwards CLI arguments unchanged:

```bash
bun install
bun run start --port 4141
```

Only Bun is needed as the JavaScript executable; source startup and
`bun run build:msc-auth` do not invoke a Node executable. Install the .NET 10
SDK, Visual Studio's Desktop development with C++ workload, and the Windows SDK
for the first native AOT publish or whenever the local helper sources change.
These compiler prerequisites are unnecessary when using a complete prebuilt
payload or explicit helper override.

For native publishes under Bun, the build script adds the installed Visual Studio
Installer directory to the `dotnet` child's `PATH`. Visual Studio's setup scripts
invoke `vswhere.exe` by name; this makes that installed tool discoverable while
preserving Bun's restriction on implicit current-directory executable lookup.
It does not change the machine's `PATH` or substitute for missing C++/SDK tools.

Source startup chooses the helper in this order:

1. `--msc-auth-exe <path>` (also `--msc-auth-exe=<path>`), then
   `GHC_MSC_AUTH_EXE`: use that executable and the adjacent `msalruntime.dll`
   without copying, rebuilding, or comparing it with repository sources. The
   override is authoritative; a missing or empty file fails startup instead of
   overwriting it or silently falling back.
2. `MSC_AUTH_DIR`: validate that directory contains both `msc-auth.exe` and
   `msalruntime.dll`, then copy its `.exe`/`.dll` files to `dist/msc-auth` without
   invoking a compiler. An incomplete directory fails even if an old copy exists
   in `dist/msc-auth`.
3. Otherwise, reuse an unchanged local native build or run `dotnet publish` into
   `dist/msc-auth`. Reuse requires both payload files to be nonempty and their
   modification times and sizes to match the successful build record. That
   record also tracks the script and every helper `.cs`, `.csproj`, `.props`,
   `.targets`, and `.resx` file recursively, excluding `bin/`, `obj/`, and `out/`.
   Added, changed, or removed sources, a missing/replaced DLL, or a missing build
   record require a new publish. NuGet's original DLL timestamp alone does not
   make every startup rebuild.

For example, `bun run start --msc-auth-exe C:/tools/msc-auth/msc-auth.exe`
uses a user-managed payload without requiring .NET or changing that directory.
Keep `MSC_AUTH_DIR` set when using a prebuilt payload across source starts;
removing it returns to local-source freshness checks.

On non-Windows platforms source startup prints an explicit Windows-only skip
and continues with the GitHub CLI path; it does not attempt to compile or copy
the helper. M365 remains unavailable there. `dev` and `serve` still launch the
source CLI directly; use `bun run build:msc-auth` first for those commands.

A failed publish or incomplete payload exits nonzero before the source CLI is
loaded; a helper-ready message means the payload is prepared, not that WAM
sign-in or a gateway token has been verified.

## Build

```bash
bun run build:msc-auth                                 # Prepare the native payload
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
msc-auth --json             # token JSON plus username, home_account_id, and environment
msc-auth                    # the same JSON payload
msc-auth --accounts         # list broker accounts (username, home id, environment)
msc-auth --account <id|upn>  # exact home account ID or email; ambiguous emails require an ID
msc-auth --upn <upn>        # exact email, never substring matching or a different account
msc-auth --tenant <tid>  # pick the authority tenant
msc-auth --interactive   # sign in through WAM, even when an account is already selected
msc-auth --verbose       # MSAL diagnostics on stderr
```

Exit codes: `0` success, `2` no account selected or interaction required,
`3` broker/MSAL failure. Diagnostics go to stderr; stdout carries only the
payload.

There is no hard-coded user email. Without a selector, the helper chooses a
unique account in the authority tenant, or the only broker account; otherwise
it exits with guidance to select a home account ID. Explicit selectors never
fall back to another account. MSAL `Always` cache diagnostics and account-list
traces require `--verbose`; real warnings and errors remain visible.

Consumer accounts (MSA) are **out of scope** for gateway tokens. Windows broker
enumeration is not the Copilot app's complete profile list. For a missing work
account, use the Dashboard's **Sign in another M365 account** action or
`msc-auth --interactive --upn you@company.com`, finish WAM sign-in, and refresh
the broker list. Dashboard sign-in returns identity fields only, never a token,
and does not change the active target until the selection is applied.

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
`dist/msc-auth/**`. `bun run build` runs tsdown first (which clears `dist/`),
then `bun run build:msc-auth` prepares the helper. `prepack` delegates to that
build; helper preparation is not deferred to pack time. Constraints:

- Native compilation runs on Windows only. `MSC_AUTH_DIR` supplies a complete
  prebuilt payload on any packaging host, including Linux. Unlike source-start
  overrides, `GHC_MSC_AUTH_EXE` and `--msc-auth-exe` never replace the packaged
  payload. Without `MSC_AUTH_DIR`, non-Windows builds explicitly skip the helper.
  The npm publishing workflow (`release-npm.yml`) must provide a Windows-built
  artifact through `MSC_AUTH_DIR` before `npm publish`; otherwise the directory
  is absent from the tarball.
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
