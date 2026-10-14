# Canonical Account Alias Follow-up (2026-10-14)

Scope: the second-round canonical-ID changes in
`src/server/account-manager.ts`, reviewed together with the current S1-S4
working-tree changes. This is a source-only review; no application was
started, no dependencies were installed, and no business source was changed.

## Conclusion

The canonical alias repair is **correct for the targeted lifecycle and session
mutation paths**. The public methods now capture and use the canonical ID for
session stores, returned `accountId` values, `isActive()` checks, responding
runtime keys, and Codex turn coordination:

- `createSession()`
- `renameSession()`
- `updateSessionRuntime()`
- `activateSession()`
- `resetSession()`
- `deleteSession()`
- `continueSession()`

`ensureAccountOpen()` resolves the account through `loadAccount()` before
checking `closingAccounts` and `stoppingAccounts`, so a path alias accepted by
`normalizeAccountId()` cannot bypass those lifecycle gates.

## Detailed Checks

### Canonical return and responding keys

The repaired methods capture `canonicalAccountId` and pass it to
`sessionSummary()`, `isActive()`, `storeFor()`, `setSessionResponding()`, and
`sessionRuntimeKey()`. This closes the prior mismatch where a request using an
alias could return an alias `accountId` or query a different responding key.

`deleteSession()` now removes the canonical responding key. The normal
`continueSession()` start/finally path also uses the canonical key, so cleanup
is symmetric.

### `isSessionStreamEnabled()`

`isSessionStreamEnabled()` now resolves the account with `loadAccount()` and
passes the canonical ID to `storeFor()`. It is a read/check operation and does
not itself perform a mutation. The subsequent `continueSession()` call still
runs `ensureAccountOpen()`, so a stopping or closing account cannot proceed
through the HTTP message endpoint merely because stream mode was checked first.

One behavioral distinction remains intentional: `isSessionStreamEnabled()` does
not call `ensureAccountOpen()`. In a stop/remove race it may read state just
before `continueSession()` rejects the operation. No lifecycle bypass was found.

### Account loading and lifecycle recursion

`ensureAccountOpen()` calls `loadAccount()` and returns the stored account ID.
`startAccount()` calls it, then calls `setAccountEnabled()` or `loadAccount()`
with that canonical ID. `refreshAccount()` loads once, checks the canonical
ID, and then starts with that canonical ID. `storeFor()` also canonicalizes
through `loadAccount()`.

This creates repeated file reads in a few paths, but no recursion:

```text
ensureAccountOpen -> loadAccount
start/refresh -> setAccountEnabled or loadAccount
storeFor -> loadAccount
```

No call chain loops back into `ensureAccountOpen()`.

### Closing/stopping behavior

`removeAccount()` records `account.accountId` (the canonical value) in
`closingAccounts`. `stopAccount()` records the canonical value in
`stoppingAccounts`. All repaired mutation methods compare against those same
canonical keys. An alias therefore receives the same “being removed” or
“stopping” rejection as the canonical URL.

`stopAccount()` itself intentionally does not call `ensureAccountOpen()`: it is
also called internally by `removeAccount()` while the account is already in the
closing set. This is not an alias gap; it is required for the shutdown path.

### Session ID cross-account behavior

Each operation obtains its `RuntimeStateStore` from the canonical account
before looking up the session, so a session ID from account A is not resolved
against account B's store. No cross-account read or mutation was found.

The shared `SessionTurnCoordinator` indexes active turns by `sessionId` alone.
Because API-created IDs are UUIDs, collisions are not expected in normal
operation. A manually corrupted state file containing duplicate session IDs
across accounts could cause a reset/delete operation in one account to observe
the other account's active-turn flag and reject; this is a local state-integrity
edge case, not an account takeover or data disclosure.

## Residual Consistency Risk

`readSessionMessages()` still receives an account ID and calls
`runnerForAccount(accountId)` directly. `storeFor(accountId)` canonicalizes the
store, but `runnerForAccount()` uses its argument as the map key. A caller that
uses a non-canonical alias on a history/attachment read could therefore create
an additional `HybridCodexRunner` for the same stored account instead of
reusing the canonical runner.

This is not a lifecycle authorization bypass, but it can cause duplicate
Codex runner instances and extra local resource use. The normal frontend uses
canonical IDs returned by `listAccounts()`. For complete consistency,
`readSessionMessages()` should capture the canonical account ID once and use it
for `storeFor()`, `runnerForAccount()`, and `accountStatePaths()`.

## S1-S4 Regression Check

- `userFacingHttpError()` is still used by the outer HTTP catch, NDJSON error
  path, attachment stream error path, and `checkCodex()`. No new raw backend
  error path was introduced by the alias changes.
- Outbound media calls still pass the optional `maxBytes` parameter, and
  historical attachment serving still passes
  `min(loadConfig(...).maxInboundBytes, DEFAULT_MAX_OUTBOUND_MEDIA_BYTES)`.
- The canonical-ID edits do not change the `sendLocalMediaFile()` signature or
  the `serveSessionAttachment()` call contract.
- No missing import, duplicate export, or incompatible call signature was found
  by static call-site inspection.

## Follow-up Patch

The residual resource-consistency issue was patched after this review:
`readSessionMessages()` now resolves the canonical account ID once and uses it
for `storeFor()`, `runnerForAccount()`, and `accountStatePaths()`. A subsequent
static call-site check found no remaining alias use on that history/attachment
path.

## Final Classification

**Pass for S3 target behavior.** No alias-based lifecycle gate bypass,
cross-account session lookup, or responding-key mismatch remains in the
repaired mutation methods.

The follow-up resource-consistency patch is complete. The remaining S2 TOCTOU
risk is documented separately and requires a local concurrent writer to
reproduce; it was not changed in this batch.
