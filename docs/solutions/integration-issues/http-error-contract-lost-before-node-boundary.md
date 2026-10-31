---
title: HTTPError contract is lost before the HTTP boundary on Node
date: 2026-10-31
last_updated: 2026-10-31
category: integration-issues
module: Elysia error composition
problem_type: integration_issue
component: tooling
symptoms:
  - "A locally rejected request returns `text/plain` `{\"name\":\"HTTPError\",\"message\":\"...\"}` instead of the `{ \"error\": { ... } }` envelope"
  - "The status is correct but `error.type`, `error.param`, `error.code`, and `Retry-After` are gone"
  - "The Dashboard records `HTTP 400 (invalid_request_error)` while the client body has no type"
  - "Only reproduces under `node dist/main.mjs`; the same build under Bun returns the full envelope"
root_cause: framework_adapter_order
resolution_type: code_fix
severity: high
related_components:
  - "development_workflow"
tags:
  - "runtime-parity"
  - "bun-vs-node"
  - "elysia"
  - "error-contract"
  - "selfcheck"
---

# HTTPError contract is lost before the HTTP boundary on Node

## Symptom

`POST /v1/responses` with an unresolvable model returns status 400 with
`content-type: text/plain` and body `{"name":"HTTPError","message":"The selected
model could not be resolved."}` on a Node-hosted proxy. The same build under Bun
returns `application/json` and
`{"error":{"message":"...","type":"invalid_request_error","param":"model"}}`.
Upstream failures lose `Retry-After` the same way. Reported in #92.

## Root cause — two layers, neither in this repo

1. `elysia/dist/compose.mjs` pre-calls `error.toResponse()` in its composed
   error handler, but the final statement overwrites the result with the raw
   error: `return mapResponse(context.response = error, set)`. The stored
   `Response` is used only if the registered `onError` hook returns one itself.
2. `@elysiajs/node@1.4.5` `mapResponse` switches on the value and checks
   `response instanceof Error` **before**
   `typeof response.toResponse === 'function'`. `HTTPError extends Error`, so it
   lands in `errorToResponse()`, which serializes only `name`, `message`, and
   `cause`, and marks the body `text/plain`.

Bun's adapter checks `toResponse` first, so the two runtimes diverge exactly at
this boundary.

Neither layer has an upgrade that fixes it: `elysia` 1.4.30 (latest) and the
`2.0.0-beta.32` line still generate
`return mapResponse(context.response = error, set)`, and `@elysiajs/node`
1.4.5 is the latest published version. The proxy's public error contract cannot
be delegated to either.

## Resolution — the proxy owns the wire contract

`onError` in `src/server.ts` calls `toErrorResponse`, which is **total**: every
thrown value produces a `Response`, and no branch returns `undefined` or hands
an `Error` to the adapter. (`undefined` was the old return for `code ===
'HTTP'`; that is the entire bug.) The hook then derives `set.status` from that
response, so the access log and the request record cannot drift from the bytes
the client receives.

`HTTPError.toResponse()` still defines the envelope, but it is called by the
mapper, not by the framework. `.error({ HTTP: HTTPError })` remains registered
only so `onError` receives `code: 'HTTP'` for observability classification; no
serialization branch reads it.

## Why the existing coverage missed it

`probeHttpErrorResponseContract` and `probeProtocolPayloadContract` both call
`.toResponse()` directly. They pass on Node while a real route throws
`HTTPError` and loses the contract — a unit probe cannot observe an adapter
that never calls the method.

The permanent gate is `probeHttpErrorTransportContract` in `src/selfcheck.ts`:
it boots the real `createServer()` app on a listener, then asserts against real
sockets for

- an ordinary route that throws `HTTPError` with `Retry-After`,
- the async-generator `/v1/responses` route rejecting an unknown model.

It asserts status, `application/json` content type, `x-request-id`,
`Retry-After`, and the full error envelope, and it runs under both Bun and Node
through `bun run smoke:packaged`. Verified failing against the pre-fix tree
(`ordinary route returned content type "text/plain; charset=UTF-8"`) and passing
after.

## Lesson

A framework's error *contract* is implemented by the adapter, not by the error
class. When a class carries its own serialization, keep the decision of *when*
to serialize — and make the mapping total — inside the app, so a framework or
adapter regression cannot silently redefine the public contract. Prove it by
pushing a throw through the real listener on every supported runtime; see
`docs/solutions/testing/green-suite-is-evidence-about-one-runtime.md`.
