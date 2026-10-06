# Attachment upload fails on a new bot chat — diagnosis, evidence, fix

Reported 2026-09-14 10:22 from the user's iPhone: attaching a photo to a **new**
bot chat fails with the composer error _"An attachment didn't upload. Remove it
or try again."_ Retried, failed again.

## Verdict

Not a phone bug, not a tunnel bug, not v1.3.1 version skew. A **pre-existing
latent defect in the web upload queue**, reproduced on this dev box in desktop
Chrome against `http://127.0.0.1:38472` with a 6.2 MB PNG.

The upload queue read the environment's HTTP base URL from a **stream-backed
atom that only produces a value while something has it mounted**. A brand-new
chat renders no message, so nothing on screen subscribes to that atom, so the
read answered `null` — forever, not as a race. The queue then failed at step
`resolve-url` and **never issued the HTTP POST**, after the server had already
minted a pending upload.

## Evidence

### 1. Server side — the bytes never arrived

`C:/Users/Ht/.personal-bots/dev/userdata/logs/server.trace.ndjson`, incident
window (times are local):

```
10:22:48  ws.rpc.attachments.createUploadUrl   Success    (mint #1)
10:23:03  ws.rpc.attachments.delete            Success    (user removed it)
10:23:08  ws.rpc.attachments.createUploadUrl   Success    (mint #2)
```

No `http.server POST /api/attachments/upload/*` span anywhere in that window —
the only ones in the whole file are the orchestrator's `curl` probes at 10:28:39
(404 on a bogus token, local and over the tunnel, proving the route is live).
Not a 400, not a 413: no request at all.

### 2. Reproduced locally, desktop Chrome, local origin

Paired a clean isolated browser context via `scripts/personal/pair.ps1` (token
`QSJFVULZQSCB`, single use, consumed), opened the **Scout** chat (empty, "New
chat"), attached a 6.2 MB PNG:

- `attachments.createUploadUrl` succeeded server-side at 10:42:40 / 10:44:35 /
  10:45:11 (three attempts).
- DevTools network panel: **zero** requests to `/api/attachments/upload/*`.
- Pressing Send produced the user's exact string: _"An attachment didn't upload.
  Remove it or try again."_

So the phone, iOS, Safari, the Cloudflare tunnel and the 10:22 build are all
eliminated as variables.

### 3. Instrumented — the XHR is never opened

Re-navigated with an `initScript` wrapping `XMLHttpRequest.prototype.open` and
`window.URL`. After attaching:

```json
{ "xhr": [], "urlErrors": [/* 4 unrelated, all at boot inside atomRegistry */] }
```

`uploadBytes` calls `xhr.open` synchronously inside the Promise executor, so an
empty log means the transport was never reached. `resolveAssetUrl` never threw
either. The only remaining branch in `runAttachmentUploadCycle` is
`resolveUploadUrl` returning `null` — i.e. `readPreparedConnection` answered
`null`.

### 4. The controlled A/B that names the variable

Same build, same origin, same file, same page session:

| Thread              | Transcript         | POST issued?                                                   |
| ------------------- | ------------------ | -------------------------------------------------------------- |
| Scout `09363aba…`   | empty (new chat)   | **no** — fails                                                 |
| Planner `83c9bc7d…` | has a user message | **yes** — `POST /api/attachments/upload/eyJ2ZXJzaW9uIjox…` 200 |

The only consumer of the prepared connection on the conversation screen is
`UserMessage` in `apps/web/src/features/personal/MessageList.tsx:68`
(`useAssetUrls` → `usePreparedConnection`), and `UserMessage` renders only when
the thread already has a user message.

A third run (load Planner, then `history.pushState` into Scout with no reload)
also failed, which rules out "warm once, warm forever": what matters is a
**live subscriber at the moment of upload**, exactly the variable the fix
addresses.

### 5. Why `readPreparedConnection` returns null

`packages/client-runtime/src/state/session.ts`:

```ts
const preparedConnectionAtom = Atom.family((environmentId) =>
  runtime.atom(followStreamInEnvironment(environmentId /* supervisor.prepared */), {
    initialValue: Option.none<PreparedConnection>(),
  }),
);
```

Stream-backed, initial value `None`. The stream runs only while the atom has a
subscriber. `readPreparedConnection` was a bare one-shot
`appAtomRegistry.get(...)`, which neither mounts the atom nor waits for it.

## Not a regression from the overnight batch

`fe54c1a72..HEAD` (`ce83b6dd0` / `e31a33806` / `027fdb6d2`, shipped 04:30 as
v1.3.1) does not touch the upload path. Last commit per file:

| File                                             | Last touched by        |
| ------------------------------------------------ | ---------------------- |
| `apps/web/src/lib/attachmentUploadQueue.ts`      | `299404a75` (upstream) |
| `apps/web/src/state/session.ts`                  | `95305c36f` (upstream) |
| `packages/client-runtime/src/state/session.ts`   | `6e8931d75` (upstream) |
| `apps/web/src/assets/assetUrls.ts`               | `4fed6cfb3` (upstream) |
| `apps/web/src/features/personal/MessageList.tsx` | `211d27d29`            |

`027fdb6d2`'s `omitProviderWorkspaceData` change affects the server-config
subscription payload only, not the prepared connection. The removed
`PersonalUsageSection` never touched it either. The 00:56 success was in a chat
that already had messages — consistent, no regression required.

## Fix

Three files, smallest change that is correct by construction rather than by
timing.

1. `apps/web/src/state/session.ts` — new `awaitPreparedConnection(environmentId,
{ timeoutMs })`. Fast-paths the registry read, otherwise **subscribes**
   (which is what starts the supervisor stream) and waits for the first `Some`,
   resolving `null` only when the 10 s wait elapses — which really does mean
   "not connected". `readPreparedConnection` stays for render-time callers and
   now carries a doc comment explaining when it lies.
2. `apps/web/src/lib/attachmentUploadQueue.ts` — `resolveUploadUrl` awaits the
   prepared connection instead of reading it, and bails to `null` if the job was
   cancelled during the wait (so a cancel mid-wait doesn't push 6 MB uselessly).
3. `packages/client-runtime/src/state/attachments.ts` — `resolveUploadUrl` may
   now return `string | null | Promise<string | null>`, and the cycle awaits it.
   Widening only; the mobile and browser-recording callers stay synchronous.

## Tests

- `apps/web/src/state/session.test.ts` (new, 4 cases) — the root cause itself:
  answers from the registry when mounted; **subscribes and waits when nothing
  has mounted the atom**, ignoring the initial `None` tick; releases the
  subscription when the listener fires synchronously; gives up with `null` on
  timeout.
- `apps/web/src/lib/attachmentUploadQueue.test.ts` — regression case "uploads
  once the prepared connection arrives, even when it is not mounted yet"
  (asserts the POST URL) plus "fails as not connected when the prepared
  connection never arrives" (asserts no XHR and `reason: "Not connected"`). The
  old suite mocked `readPreparedConnection` to a live connection unconditionally,
  which is why the fixture could never have caught this.
- `packages/client-runtime/src/state/attachments.test.ts` — the cycle waits for
  an async resolution before transferring, and still fails at `resolve-url` when
  it answers `null`.

**Mutant check:** reverting `await input.resolveUploadUrl(...)` to the
unawaited form makes 4 of the web queue tests fail (including a 15 s timeout on
the not-connected case). The new tests do fail against the old behaviour.

## Gates

| Gate                                                                  | Result                                 |
| --------------------------------------------------------------------- | -------------------------------------- |
| `apps/web` `vp test run --project unit src/features/personal`         | 28 files, **186 passed**               |
| `apps/web` `vp test run --project unit src/lib src/state`             | 50 files, **456 passed**               |
| `packages/client-runtime` `vp test run src/state/attachments.test.ts` | **10 passed**                          |
| `tsc --noEmit` — web / client-runtime / mobile / server               | clean (suggestions only, pre-existing) |
| `vp lint` on all five touched files                                   | clean                                  |

`apps/server` was not touched, so its `src/personal` suite was not run; its
typecheck is clean.

## Not verified live

The running server serves a built release. Confirming the fix in the browser
needs a build + restart, which was explicitly out of scope for this task (no
deploy, no app-version bump). To confirm after the next release:

1. Open a bot chat with an **empty** transcript.
2. Attach a multi-MB image.
3. DevTools network panel must show `POST /api/attachments/upload/<token>` →
   `204`, and the server trace must show a matching `http.server POST` span.

## Left open (deliberately out of scope)

- `apps/web/src/browser/browserRecordingUpload.ts:41` still uses the
  synchronous `readPreparedConnection` and carries the same hazard. The personal
  Computer screen mounts the atom via `computer/computerState.ts:76`, so it is
  likely masked there — but it is the same defect and should get the same
  treatment.
- The composer renders **no** failed/uploading state on the attachment chip. The
  only feedback is the error banner after pressing Send, which is why the user
  had no idea anything was wrong until then. Worth a UI pass.
- The failed upload leaves a pending attachment on the server (by design: the
  id is kept for retry), so the incident left orphaned pending rows that the
  24 h sweep will clear.
