# Current Security Fix Review (2026-10-14)

Scope: current working-tree changes for S1-S4 in `src/bridge/errors.ts`,
`src/bridge/service.ts`, `src/server/http-server.ts`,
`src/server/account-manager.ts`, and `src/weixin/media.ts`.

This is a source review only. No application was started, no dependencies were
installed, and no business source was changed.

## Executive Summary

- S1 error sanitization: **Pass with a minor semantic caveat**. User-visible
  HTTP/NDJSON/WeChat errors no longer include the original exception text in the
  reviewed paths. HTTP status selection still uses the original message, which
  can produce an imprecise status code but does not expose the message.
- S2 media size and regular-file checks: **Partially pass**. The normal path
  enforces a 100 MiB/configured limit for outbound upload and checks the limit
  again before serving a historical attachment. The checks are still
  path-based and therefore vulnerable to symlink/TOCTOU replacement by a local
  writer of an allowed workspace.
- S3 canonical account gate: **Pass for lifecycle gate enforcement; residual
  state-consistency issue**. `ensureAccountOpen()` canonicalizes before checking
  `closingAccounts`/`stoppingAccounts`, and the main mutation path
  `continueSession()` now carries the canonical ID through its maps and runner
  calls. Several session mutation methods still retain the caller-supplied alias
  for response/runtime-key bookkeeping.
- S4 type/signature/import review: **No source-level mismatch found**. The new
  `maxBytes` parameter is optional and preserves existing test call sites;
  `serveSessionAttachment()` has one updated call site; imports resolve to
  existing exports.

## Findings

### P2 - Attachment and outbound-media path checks remain TOCTOU-prone

**Locations**

- `src/weixin/media.ts:73-90, 299-310`
- `src/server/account-manager.ts:666-692`
- `src/server/http-server.ts:622-665`

**Attack precondition**

An attacker must be able to modify files or symlinks inside an allowed
workspace while a Codex response is being processed or while a browser fetches
an attachment. This is a local same-user/workspace-writer scenario, not a
plain remote HTTP or ordinary WeChat-message capability.

**Evidence and root cause**

`isAllowedLocalFile()` resolves and checks the path with `statSync()` and
`realpathSync()`. `sendLocalMediaFile()` then performs a second `statSync()` and
later `readFileSync()` on the original path. Historical attachment serving
performs `statSync()` and then opens the original path with
`createReadStream()`. A symlink or replacement can be swapped between those
operations, so the later read is not bound to the object that passed the
workspace and regular-file checks.

The final response now rejects a file whose current `stat.size` exceeds the
100 MiB limit, so ordinary growth after the check is bounded by the range
computed from the earlier stat. That does not prevent a replacement with an
out-of-root file; the replacement can still disclose up to the requested range
from the substituted target.

**Impact**

A local workspace writer could cause an allowed outbound send or historical
attachment response to read data from outside the configured roots. The same
race can also invalidate the intended size bound. Severity is reduced because
the attacker already needs local write capability in an allowed workspace (or
equivalent control over the Codex working tree).

**Recommendation**

Open the file once and validate the opened descriptor (regular file, resolved
identity, and size) before reading/streaming. On platforms where descriptor
identity checks are available, compare the descriptor's final path or use an
open operation that does not follow symlinks. For HTTP serving, stream from the
validated descriptor rather than reopening the path.

### P2 - Canonical aliases can leave session response state keyed inconsistently

**Locations**

- `src/server/account-manager.ts:338-387`
- `src/server/account-manager.ts:571-579, 595-606`

**Attack precondition**

The caller must use a non-canonical account ID that `loadAccount()` accepts via
`normalizeAccountId()`, such as an alias that normalizes to the stored account
ID. The HTTP management API can supply account IDs from URL path segments.

**Evidence and root cause**

`ensureAccountOpen()` now canonicalizes before checking lifecycle sets, which
correctly prevents an alias from bypassing `closingAccounts` or
`stoppingAccounts`. However, methods such as `createSession()`,
`renameSession()`, `updateSessionRuntime()`, `activateSession()`,
`resetSession()`, and `deleteSession()` call `ensureAccountOpen(accountId)` but
continue to pass the original `accountId` to `sessionSummary()`,
`isActive()`, and `sessionRuntimeKey()`. `continueSession()` was corrected to
carry `canonicalAccountId`, but the sibling methods were not.

This can return a session with an alias `accountId` and report `responding:
false` while the canonical-keyed `respondingSessions` map contains an active
turn. `deleteSession()` can also delete the alias key while leaving the
canonical responding entry until the turn cleanup runs.

**Impact**

The issue is a state/response consistency defect rather than a lifecycle
authorization bypass: the canonical lifecycle checks still run before these
operations. UI polling or concurrent operations using aliases may observe
stale `responding` state and make incorrect decisions.

**Recommendation**

Capture the return value from `ensureAccountOpen()` in every account-scoped
method and use that canonical ID for stores, summaries, activity checks, and
runtime map keys. Alternatively, canonicalize once at each public method
boundary and prohibit aliases in the HTTP route layer.

## S1 Detailed Review

`startLocalHttpServer()` now maps the outer request catch to
`userFacingHttpError()`. The streaming NDJSON error branch, attachment stream
error branch, and `checkCodex()` failure path use the same sanitizer. The
WeChat bridge uses `userFacingMessageHandlingError()` for inbound download and
outbound media failures.

The sanitizer allows only a short list of intentionally user-actionable
messages (size limits, malformed request, missing session/account categories)
and replaces unrecognized errors with a generic message. In particular,
filesystem paths, command stderr, CDN response bodies, and account IDs in
`Account is ...` errors are not returned.

The remaining caveat is that `errorStatus()` still classifies the response
status using the unsanitized original message. A path or backend error
containing words such as “not found” can receive a 404, or a validation-like
word can receive a 400. This is status imprecision, not error-content exposure.

## S2 Detailed Review

Normal outbound media calls now pass:

```text
maxBytes = min(config.maxInboundBytes, DEFAULT_MAX_OUTBOUND_MEDIA_BYTES)
```

`sendLocalMediaFile()` rejects non-regular files and files above that limit
before reading the file. `sessionAttachment()` marks files above the fixed
100 MiB historical-attachment limit unavailable. The HTTP handler also checks
the current file's regular-file status and size before calculating a range and
opening the stream. This closes the straightforward “metadata says available,
then unrestricted download” path.

The remaining descriptor race is described in the P2 finding above. Also note
that `sessionAttachment()` intentionally keeps historical attachment metadata
when a later `statSync()` fails; the final HTTP lookup then rejects the missing
or non-regular file, so this behavior does not disclose the underlying
filesystem error.

## S3 Detailed Review

`ensureAccountOpen()` now resolves the stored account first and checks lifecycle
sets using the canonical `account.accountId`. `startAccount()`, `refreshAccount()`
and `continueSession()` explicitly use the canonical value where it affects
lifecycle and runner/turn coordination. Other account operations delegate to
`loadAccount()` through `storeFor()` or account persistence helpers, so no
alias-based lifecycle bypass was found.

The residual alias bookkeeping inconsistency is reported as P2 above. It should
be fixed for uniformity, but it is not evidence that an alias can operate on a
closing or stopping account.

## S4 Signature and Import Review

- `DEFAULT_MAX_OUTBOUND_MEDIA_BYTES` is exported from `src/weixin/media.ts` and
  imported by both `src/bridge/service.ts` and `src/server/account-manager.ts`.
- `sendLocalMediaFile()` adds optional `maxBytes?: number`; existing callers in
  `test/media.test.ts` remain valid.
- `serveSessionAttachment()` adds a required `maxBytes` argument and has one
  updated call site in `src/server/http-server.ts`.
- No duplicate exports, missing imports, or incompatible call signatures were
  found by static call-site inspection.

## Unverified / Residual Risks

- The TOCTOU findings require a local concurrent writer and were not reproduced
  at runtime.
- The review did not compile or execute the application, per task constraints.
- The fixed 100 MiB historical-attachment threshold is independent of a lower
  `maxInboundBytes` configuration; this is consistent with the current code's
  outbound-vs-inbound distinction but should remain documented.
