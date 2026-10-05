# Plan 11 — `path escapes workspace root: /.git`: root cause, fix, and a real conversation proving it

**Status: fixed, TDD'd, and verified in a real conversation through the shipped
composition (pre-fix failure reproduced byte-for-byte, post-fix turn completed).
One correction to the brief's working theory, one caller identified with a
runtime stack, and one thing the brief asked me to guard against that the data
says does not exist.**

| | |
|---|---|
| Base | `9de5d8e` (branch `main`, clean) — **`447b8b5` does not exist in this repository** (`git cat-file -t 447b8b5` → `fatal: Not a valid object name`); `9de5d8e` is the tip and is the commit named in the brief as "last known" |
| Fix | `fix(fs-k8s): answer a path outside the workspace root as absent, not as a permission failure` |
| Diff | 5 files, +523/−16 — `packages/fs-k8s/src/index.ts`, `tests/outside-the-root.spec.ts` (new), `tests/official-walk.ts` (new), `tests/paths.spec.ts`, `tests/fs-k8s.spec.ts` |
| Write scope | respected: only `packages/fs-k8s/**`. `workspace-k8s`, `subprocess-k8s` and `docker/profiles/*.cordis.patch.yml` are **unchanged** (and the reasons are below) |
| Constraints | no DSH version change, no new runtime dependency, no bundle patching, no re-vendoring, no deploy-repo change, `pnpm-lock.yaml` untouched |
| Preserved | 7b536ea's fence (dotfiles inside a workspace still work; ordinary paths under the root still route), the creation refusal, one-warn-per-path |

---

## 1. The correction: the base `/` is not a session cwd, and `/` is not a data problem

The brief's second question was whether `/.git`'s base `/` comes from a session
whose `f_cwd` is `/`. **It does not.** `t_sessions` on the live cluster, read
through the production database (queried from the CNPG pod in `open-webui`, the
store the `dsh-db` secret points at):

```
$ kubectl exec -n open-webui shared-pg-ce-1 -c postgres -- \
    env PGPASSWORD=… psql -h 127.0.0.1 -U app -d app -Atc \
    "SELECT f_session_id || ' | ' || coalesce(f_cwd,'<null>') FROM t_sessions ORDER BY f_created_at DESC LIMIT 12;"

session-2ddbd497-02da-41d7-a03b-18c500c2a3a6 | /workspaces/agents
session-0f640710-3fb6-4069-8adf-38e1a2e982e0 | /workspaces/agents
session-26d4a685-32bf-44a8-8321-1af198d31b6a | /workspaces/agents
session-807110aa-2ed4-431c-bd82-14f6bf63ee70 | /workspaces/agents
session-adcbcc9a-06d4-4251-8e32-9ee0bec0f9bd | /workspaces/test-db
session-af80e08a-ffe9-4004-b904-7aad27d07695 | /workspaces/git
…
$ … "SELECT coalesce(f_cwd,'<null>') || ' -> ' || count(*) FROM t_sessions GROUP BY f_cwd ORDER BY count(*) DESC;"
/workspaces/agents -> 4
/workspaces/test-db -> 2
/workspaces/test-final -> 1
/workspaces/test-pod -> 1
/workspaces/git -> 1
/workspaces/test-upgrade -> 1
```

Every session has a workspace cwd; **no session anywhere has `cwd = '/'`**, and
none has a null cwd. So the "session with `cwd=/`" failure mode this platform
diagnosed before is **not** what is happening here, and no session-creation guard
was added — there is no session for it to refuse, and inventing one would be an
unverifiable change outside the failing path.

The base `/` comes from the **caller walking up**, not from the workspace:

```
findProjectRoot: current = resolve(cwd)          // e.g. /workspaces/agents
                 … probe join(current, '.git')   // /workspaces/agents/.git  → yes
                 parent = dirname(current)       // /workspaces
                 … probe join(current, '.git')   // /workspaces/.git       → yes
                 parent = dirname(current)       // /
                 … probe join(current, '.git')   // /.git                  → OUTSIDE
                 parent = dirname('/') === '/'   // end of walk
```

`dirname('/') === '/'` is what terminates the loop, so `/.git` is the **last
probe of every session that has no `.git` anywhere in its ancestry** — the
workspace root included. `posix.join('/', '.git') === '/.git'`, which is why the
path is `/`-based and not `/workspaces`-based.

The operator's workspace really has no `.git`, checked in the live pod:

```
$ kubectl exec -n dsh-platform agents -- ls -la /workspaces/agents/.git
ls: cannot access '/workspaces/agents/.git': No such file or directory
$ kubectl exec -n dsh-platform agents -- env | grep DAEMON_ROOT
DAEMON_ROOT=/workspaces/agents
```

---

## 2. Who asks for `.git` (question 1), with file:line and a runtime stack

The brief asked for every caller, not the first plausible one. I found four
message-time callers of `/.git`-shaped probes and named them by **capturing the
real stack** in a real turn (the fixed provider was instrumented in the
throwaway harness copy to print `new Error().stack` for every out-of-root path it
degrades; the repo was not touched for this). One turn produced exactly these:

```
[DIAG] out-of-root path asked for by: /.git
Error: caller stack
    at Proxy.outsideTheWorkspaceRoot   (…/@visecy/dsh-fs-k8s/dist/index.js:265:80)
    at Proxy.resolve                   (…/@visecy/dsh-fs-k8s/dist/index.js:316:18)
    at existsAsMarker                  (…/dsh-agent-instructions/lib/index.js:453:35)
    at findProjectRoot                 (…/dsh-agent-instructions/lib/index.js:483:43)
    at async compose                   (…/dsh-agent-instructions/lib/index.js:1123:23)
    at async Object.<anonymous>        (…/dsh-agent-instructions/lib/index.js:1275:19)
    at async Object.<anonymous>        (…/dsh-tool-skill/lib/index.js:204:20)

[DIAG] out-of-root path asked for by: /home/…/harness-post/home/AGENTS.md
    at fsStatFile                      (…/dsh-agent-instructions/lib/index.js:430:35)
    at statFile                        (…/dsh-agent-instructions/lib/index.js:449:62)
    at discoverInstructionFiles        (…/dsh-agent-instructions/lib/index.js:562:32)
    at loadBaselineInstructionSet      (…/dsh-agent-instructions/lib/index.js:670:27)
    at async compose                   (…/dsh-agent-instructions/lib/index.js:1133:31)

[DIAG] out-of-root path asked for by: /.git
    at pathExistsInFileSystem          (…/dsh-skill-filesystem/lib/index.js:823:21)
    at pathExists                      (…/dsh-skill-filesystem/lib/index.js:817:34)
    at findProjectRoot                 (…/dsh-skill-filesystem/lib/index.js:810:13)
    at roots                           (…/dsh-skill-filesystem/lib/index.js:153:24)

[DIAG] out-of-root path asked for by: /home/…/harness-post/home/skills
[DIAG] out-of-root path asked for by: /home/ovizro/.agents/skills
    at listSkillRootEntriesFromFileSystem (…/dsh-skill-filesystem/lib/index.js:629:26)
    at listSkillRootEntries               (…/dsh-skill-filesystem/lib/index.js:622:17)
    at discoverRoot                       (…/dsh-skill-filesystem/lib/index.js:617:63)
    at …                                  (…/dsh-skill-filesystem/lib/index.js:583:24)
```

### The one that fires on a message and kills the turn

**`@deepseek-ai/dsh-agent-instructions` — `existsAsMarker` at
`lib/index.js:453`, called from `findProjectRoot` at `lib/index.js:483`, called
from `compose` at `lib/index.js:1123`.**

```js
// dsh-agent-instructions/lib/index.js
480  async function findProjectRoot(cwd, markers, fileSystem, signal) {
481    let current = resolve(cwd);
482    for (;;) {
483      for (const marker of markers) if (await existsAsMarker(join(current, marker), fileSystem, signal)) return current;
484      const parent = dirname(current);
485      if (parent === current) return resolve(cwd);
486      current = parent;
487    }
488  }
451  async function existsAsMarker(path, fileSystem, signal) {
452    if (fileSystem !== void 0) try {
453      const target = await fileSystem.resolve(path, signalOptions(signal));
454      return await fileSystem.stat(target, signal) !== void 0;
455    } catch (error) {
456      signal?.throwIfAborted();
457      if (isMissingProviderPathError(error)) return false;
458      throw error;            // <-- the arm the turn dies in
459    }
410  function isMissingProviderPathError(error) {
411    return error instanceof Error && "code" in error && error.code === "FS_NOT_FOUND";
412  }
```

`compose` is the per-step instruction projection: it runs at the start of every
turn, for every agent, before the model call. That is why **every message failed**
and not just some.

### The three that do not

* `dsh-agent-instructions` `fsStatFile` (:430, via `statFile` :449 →
  `discoverInstructionFiles` :562 → `loadBaselineInstructionSet` :670 →
  `compose` :1133) probes the DSH_HOME user-global `AGENTS.md`
  (`/home/node/.dsh/AGENTS.md` in the deployment) — also outside `hostRoot`,
  also reached on every turn. Its `catch` at :443 returns
  `{kind:'unavailable'}` for *anything*, so it was never fatal — but it was
  another silent victim of the same misclassification, and it is now answered
  precisely instead of by a blanket catch.
* `dsh-skill-filesystem` `findProjectRoot` (:810, via `pathExists` :817 →
  `pathExistsInFileSystem` :823 → `roots` :153) performs the **same upward
  `.git` walk** for the skill registry. Its `pathExistsInFileSystem` catches
  every error, so it never fired — the same defect in a second official package,
  harmless only by accident of a broader `catch`.
* `dsh-skill-filesystem` `discoverRoot` (:583 → :617 → :622 → :629) probes
  `<dshHome>/skills` and `~/.agents/skills`; tolerant (`isAbsentSkillPathError`,
  :575-577).

### Ruled out, with evidence

| Candidate | Verdict |
|---|---|
| git/context providers in the agent loop | `dsh-time-context`, `dsh-tmux-context`: no `.git`, no fs probe. `dsh-agent-instructions` is the agent-loop context provider that does it (§ above). |
| session title generation | `grep '.git'` over `dsh-session-title*`/`dsh-session-title-llm`/`-first-prompt-llm`: **no match**. The title path in the real transcript (`session/title-llm-request`) shows only message text. |
| `workspace-changes` family | `dsh-workspace-changes` uses its own `repository.git` (`lib/types/git.js:113`, `lib/index.js:276`) — a **local** git dir from its own env, never `ctx.fs`. It is also **disabled** in the shipped web profile. |
| file-reference providers | `dsh-file-reference-local/lib/index.js:31` and `lib/types/search.js:28`: `.git` appears only in `DEFAULT_FILE_SEARCH_EXCLUDED_DIRECTORIES`. No resolve. |
| skill registry | `dsh-skill-filesystem` — found, and named above (second `findProjectRoot`). |
| produced-file / deliverable paths | `dsh-tool-present` uses `fs.stat` on the presented workspace path only; `dsh-tool-fs-search:549` has `.git` in an exclusion list. No `/.git` resolve. |
| anything calling `ctx.fs.resolve/stat/lstat/readText` with a `.git` path | the complete set of `.git`-literals in the installed official tree is: `dsh-agent-instructions/lib/index.js:16` (default marker), `dsh-skill-filesystem/lib/index.js:810`, `dsh-tool-fs-search/lib/index.js:549`, `dsh-file-reference-local/lib/index.js:31` + `types/search.js:28`, `dsh-util-code-language` (`.gitignore` language map), `dsh-plugin-manager` (git URL specs), the two browser clients, `libreoffice-kit`'s bundled `fflate`. Only the first two reach `ctx.fs`. |

---

## 3. Why it throws instead of degrading (question 3), and the fix

`FsK8s.resolve` mapped the translator's containment assertion to
`FS_PERMISSION_DENIED`:

```ts
// before
try { podPath = this.translate.toPod(abs) }
catch (e) { throw new FsError((e as Error).message, 'FS_PERMISSION_DENIED') }
```

`translate.toPod` throws `path escapes workspace root: <path>` — an assertion
about the **host path space**, written for the control plane, in a code path
whose callers are ordinary file operations. `FS_PERMISSION_DENIED` is the one
code `existsAsMarker` does **not** tolerate, so a path the platform simply has no
world for became a platform failure that fails the turn.

7b536ea had already learned this lesson for the *neighbouring* fence — a path
whose first segment names no workspace is answered with one precise line and
`FS_NOT_FOUND`, not a throw from the resolver. It just did not reach this fence.
The consequence is visible in the git history of the operator's two failures:

```
before 7b536ea:  workspaceEndpointResolver: '.git' is not a registered workspace …   (from /workspaces/.git)
after  7b536ea:  path escapes workspace root: /.git                                  (from /.git — the NEXT ancestor)
```

The walk was simply eating one ancestor per fix. The stop condition was never
reached.

### The change (`packages/fs-k8s/src/index.ts`)

`resolve` now answers a path outside the host root the way 7b536ea taught, and
the way `/workspaces/.git` is already answered — as an **absent** path in the
platform's own terms, with one precise line and one warn per path:

```ts
override async resolve(path: string, opts?: { cwd?: string }): Promise<FsTarget> {
  const abs = opts?.cwd !== undefined && !path.startsWith('/') ? opts.cwd + '/' + path : path
  let podPath: string
  try {
    podPath = this.translate.toPod(abs)
  } catch {
    throw this.outsideTheWorkspaceRoot(abs)   // FsError(…, 'FS_NOT_FOUND')
  }
  return { targetKey: FsTargetKey(`dsh-k8s:${podPath}`), displayPath: abs }
}
```

with the shared once-per-path reporting extracted (`reportOutside`) so both
fences keep the same "one line per path per process" rule. The message names the
path, the root, and where to look instead:

```
/.git is outside the workspace root /workspaces of this platform, so it names no
workspace: no pod or volume exists for it and the control plane keeps no copy of
that path; use a path under /workspaces/<workspace-id>

WARN @visecy/dsh-fs-k8s: fs-k8s: /.git is outside the workspace root /workspaces of this
platform and names no workspace; no pod or volume was created for it
```

### Why this layer, and not the alternatives

* **Not a session-cwd guard** — §1: no session has `cwd=/`. There is nothing to
  refuse.
* **Not "serve the workspace's own `.git`"** — §4: the caller's intent is
  "is `/` a project root?", not "give me the workspace's git dir".
* **Not a change in `workspace-k8s`** — the fence there is correct and 7b536ea's
  behaviour is preserved bit-for-bit; the defect was the classification of the
  *translator's* refusal in `fs-k8s`.
* **Not a change in `subprocess-k8s`** — its `toPod` (`src/index.ts:82-96`)
  already *returns the cwd unchanged* for an out-of-root path instead of
  throwing. The sibling provider had the right shape all along; that is evidence
  the fix belongs in `fs-k8s`, not in the callers.
* **Not a profile change** — no row can express "tolerate this error", and the
  caller is an official package that must keep working against the official
  contract.
* **The pod's own `OUT_OF_ROOT` stays `FS_PERMISSION_DENIED`** (`asFsError`,
  `src/index.ts:306`). That is a different fence: the *pod* refusing a path
  outside its own root is a genuine violation, not a host path the platform has
  no world for. The two were conflated in `resolve`; they no longer are.

### Is the caller asking for the workspace's `.git`? (the brief's check)

No. `findProjectRoot(cwd, ['.git'])` asks **whether the current directory is a
project root**, for each ancestor, and its first probe *already is* the
workspace's own `.git` (`/workspaces/agents/.git`) — which the pod answers
"absent" for a workspace that is not a git repository, and which is served
normally when it does exist (`paths.spec.ts`, "serves a dotfile nested inside the
registered workspace"). Redirecting `/.git` to the workspace's `.git` would make
`/` claim to be a project root and change instruction-file discovery scope — a
lie, not an answer. "Absent" is the correct answer, and it is what the caller
acts on: `findProjectRoot` returns the session cwd as the project root, which is
the platform's own workspace root.

---

## 4. TDD evidence

The caller is transcribed verbatim into one auditable place,
`packages/fs-k8s/tests/official-walk.ts` (`isMissingProviderPathError`,
`existsAsMarker`, `findProjectRoot` — each with its `lib/index.js` line
numbers), so the unit spec and the real-daemon spec drive the *same* caller
instead of two paraphrases.

**RED, before the fix** (with the assertion messages, i.e. the operator's
string):

```
$ git stash push -- packages/fs-k8s/src/index.ts && npx vitest run tests/paths.spec.ts tests/outside-the-root.spec.ts
 × the operator's message-time walk: cwd /workspaces/agents, no .git anywhere > terminates at the workspace instead of failing the turn on /.git
   → path escapes workspace root: /.git
 × … > probes the workspace, then the root .git, then / — and only the first is a pod call
   → path escapes workspace root: /.git
 × … > never wakes a workspace for a path above the root
   → path escapes workspace root: /.git
 × … > codes the /.git refusal FS_NOT_FOUND — the one code the official probe tolerates
 × an out-of-root path is refused precisely, not served and not fatal > names the path, the root, and where to look instead, in ONE line
 × … > degrades every PATH-taking member the same way, and hands out no target at all
 × … > reports the condition once per path, not once per operation
 × the message-time project-root walk on a session in a real workspace > walks out of the workspace to /, and every refusal it sees is FS_NOT_FOUND
   → path escapes workspace root: /.git
      Tests  8 failed | 10 passed (18)
```

**GREEN, after the fix:**

```
$ npx vitest run
 ✓ tests/not-a-workspace.spec.ts  (9 tests)
 ✓ tests/outside-the-root.spec.ts (10 tests)
 ✓ tests/paths.spec.ts            (8 tests)
 ✓ tests/fs-k8s.spec.ts          (17 tests)
 ✓ tests/watch.spec.ts            (9 tests)
 Test Files  5 passed (5)
      Tests  53 passed (53)
```

New coverage (`tests/outside-the-root.spec.ts`, 10 cases; `tests/paths.spec.ts`,
1 case):

1. the **whole message-time walk** from `/workspaces/agents` terminates at the
   workspace, with the probe sequence pinned:
   `/workspaces/agents/.git` → `/workspaces/.git` → `/.git`;
2. only the first of those probes is a pod call; the resolver is never woken for
   an ancestor above the root, and the out-of-root path makes **no daemon request
   at all**;
3. the refusal is coded `FS_NOT_FOUND` — asserted through the official predicate
   itself, so the code can never silently drift back;
4. the refusal still happens (no target is handed out, so no target-taking
   member can run), with one message line and no newline;
5. one warn per path, not per operation;
6. **7b536ea stays fixed**: a `.git/HEAD` *inside* the registered workspace is
   still served by that workspace's pod, and ordinary paths under the root keep
   routing;
7. the same walk against a **real sandbox daemon** (`paths.spec.ts`), where the
   workspace's own probe really is a pod call, `/workspaces/.git` is the
   membership fence, and `/.git` is the out-of-root degradation.

`tests/fs-k8s.spec.ts` had one assertion updated, and the change is the point:
`resolve` used to be pinned to `FS_PERMISSION_DENIED` for an escape. That
assertion *was* the defect, and the comment now says so.

---

## 5. Mandatory reproduction in a real conversation

### 5.1 What was booted, and what was stood in for

Exactly the deployment's shape:

| Piece | Value |
|---|---|
| Profile | `bash scripts/harness-profile.sh <dir>` — the shipped `docker/profiles/*.cordis.patch.yml` composed onto DSH 0.2.0-rc.2 |
| CLI | the real `dsh --profile web --patch … --host 127.0.0.1 --port <p> --no-open` |
| Session store | PostgreSQL (a throwaway `verify-db` in the `dsh-verify` namespace, port-forwarded) — `session-persistence-rdb`, `storage-db`, `platform-domain` all real |
| Workspace runtime | `@visecy/dsh-workspace-k8s` against the live cluster, namespace `dsh-verify`, image `ghcr.io/visecy/dsh-platform/dsh-sandbox-daemon:v0.1.85` |
| Model | a local stub speaking the DeepSeek Messages (Anthropic) SSE protocol, injected through the row's own `baseURL` — no external network, no operator credential |
| The message | sent through the official RPC the UI uses: `session/create` then `session/prompt` (the same calls `dsh-client-ui-chat` makes) |

Substitutions, stated plainly: (a) `hostRoot` is a real top-level directory the
sandbox may write (`/tmp`) instead of `/workspaces`, because this host cannot
create `/workspaces` — the *shape* is identical, and `/tmp` is a single segment
so the first ancestor above the root is `/`, exactly as in production; (b) the
model is a stub with no tool calls, so the turn is one step; (c) for the
registered-workspace run, a 15-line `NODE_OPTIONS` preload rewrites the pod's
`http://<pod-ip>:4390` endpoint to a `kubectl port-forward`, because the control
plane here runs outside the cluster where it would normally resolve it directly.
None of these touches platform logic.

### 5.2 PRE-FIX — the operator's exact string, in a real turn

Run against the harness built from `9de5d8e` (verified: the installed
`dist/index.js` contains `path escapes workspace root` and
`FS_PERMISSION_DENIED`, and no `outsideTheWorkspaceRoot`).

```
$ node .tmp-plan11/drive-conversation.mjs --port 4185 --cwd /tmp/agents --text "hello there"
handoff: 302 -> http://127.0.0.1:4185/?token=<redacted> -> cookie minted
session: session-2cbd5ad8-993f-4e11-932c-a3cebb76ef17 (cwd /tmp/agents)
prompt: {"accepted":true}
---
sessionId: session-2cbd5ad8-993f-4e11-932c-a3cebb76ef17
events: agent/inbox/spliced -> turn/start -> agent/inbox/spliced -> turn/end
verdict: TURN FAILED: path escapes workspace root: /.git
'path escapes workspace root' in transcript: true
'FS_NOT_FOUND' in transcript: false
```

The recorded turn (`t_events`, joined through `t_session_events`, exactly what
the transcript renders):

```
--- seq=1 turn/start ---   {"turn":1}
--- seq=3 turn/end ---     {"turn":1,"reason":{"kind":"error","error":{"message":"path escapes workspace root: /.git","code":"UNKNOWN"}}}
```

That is the operator's string, character for character, produced by a real
conversation in a workspace session — and the turn never reached the model.

### 5.3 POST-FIX — the same path, the turn completes

Same driver, same arguments, same cwd, against the harness built from the fix:

```
$ node .tmp-plan11/drive-conversation.mjs --port 4188 --cwd /tmp/agents --text "hello there"
session: session-cda3ffbc-2b1e-4745-9df2-375c6e32becd (cwd /tmp/agents)
prompt: {"accepted":true}
---
events: agent/inbox/spliced -> turn/start -> agent/inbox/spliced -> step/start -> system/message
        -> user/message -> user/message -> request/header -> request/context -> session/title
        -> session/title-llm-request -> session-log-deepseek/delivery-accepted -> assistant/message
        -> step/end -> turn/end -> session-log-deepseek/delivery-accepted -> session/title
verdict: TURN COMPLETED: {"kind":"completed"}
'path escapes workspace root' in transcript: false
'FS_NOT_FOUND' in transcript: false
```

with the assistant message in the transcript:

```
--- seq=12 assistant/message ---
{"turn":1,"step":1,"message":{"role":"assistant","content":[{"type":"text","text":"STUB-MODEL-REPLY"}], … }}
--- seq=14 turn/end --- {"turn":1,"reason":{"kind":"completed"}}
```

and the control-plane log (`logging-stdout`, warn level) showing the *precise,
once-per-path* degradation instead of a failure:

```
WARN @visecy/dsh-fs-k8s: fs-k8s: /tmp/agents/.git is outside every workspace of this platform ('agents' is not registered under /tmp); no pod or volume was created for it
WARN @visecy/dsh-fs-k8s: fs-k8s: /tmp/.git is outside every workspace of this platform ('.git' is not registered under /tmp); no pod or volume was created for it
WARN @visecy/dsh-fs-k8s: fs-k8s: /.git is outside the workspace root /tmp of this platform and names no workspace; no pod or volume was created for it
WARN @visecy/dsh-fs-k8s: fs-k8s: /home/…/harness-post/home/AGENTS.md is outside the workspace root /tmp of this platform and names no workspace; no pod or volume was created for it
```

(`/tmp/agents/.git` appears here only because this run deliberately left the
workspace unregistered, so the fence answers it; see 5.4 for the registered
case, where that probe goes to the pod and is not degraded at all.)

### 5.4 POST-FIX with a REGISTERED workspace, a real pod and a real daemon

The strongest variant: the workspace is registered through the platform's own
API (`POST /workspaces/api/create`), a real pod runs in `dsh-verify`, and the
session is created with `session/create {workspaceId}` — the UI's own path, so
the controller takes the cwd from the registry record:

```
$ node .tmp-plan11/drive-conversation.mjs --port 4189 --registered --workspace agents --text "hello there"
session: session-3e189858-7584-41b5-a0a6-6f6edf3a62e5 (workspace agents)
prompt: {"accepted":true}
---
events: … -> assistant/message -> step/end -> turn/end -> …
verdict: TURN COMPLETED: {"kind":"completed"}
'path escapes workspace root' in transcript: false
```

The workspace's own `.git` probe really went to the pod's daemon
(`[daemon-shim] http://10.42.112.159:4390/files/info -> http://127.0.0.1:14390/files/info`),
the daemon answered `{"ok":true,"data":{}}` (no `info` ⇒ absent), and only the
two ancestors above the workspace were degraded:

```
WARN fs-k8s: /tmp/.git is outside every workspace of this platform ('.git' is not registered under /tmp); no pod or volume was created for it
WARN fs-k8s: /.git is outside the workspace root /tmp of this platform and names no workspace; no pod or volume was created for it
```

The live pod confirms the daemon's answer for the deployment's own image:

```
$ kubectl exec -n dsh-verify agents -- node -e '… fetch /files/info {path:"/.git"} …'
/.git -> {"ok":true,"data":{}}
```

No PVC and no pod is ever created for a refused path — `kubectl -n dsh-verify
get pvc | grep -E '\.git'` is empty after all runs.

---

## 6. Verification (pasted)

### 6.1 `pnpm install --frozen-lockfile`

```
Scope: all 15 workspace projects
Already up to date
Done in 1.1s using pnpm v11.25.0
=== INSTALL OK ===
```

### 6.2 `pnpm -r build`

```
packages/fs-k8s build: built fs-k8s -> dist/index.js
packages/fs-k8s build: Done
packages/subprocess-k8s build: built subprocess-k8s -> dist/index.js
packages/subprocess-k8s build: Done
packages/workspace-k8s build: built workspace-k8s -> dist/index.js
packages/workspace-k8s build: built @visecy/dsh-workspace-k8s client UI -> lib/client.js
packages/workspace-k8s build: Done
=== BUILD OK ===
```

### 6.3 `pnpm -r test`

```
packages/logging-stdout test:            Tests  10 passed (10)
packages/platform-domain test:           Tests  20 passed (20)
packages/auth-oidc test:                 Tests   7 passed (7)
packages/identity-bridge test:           Tests  31 passed (31)
packages/storage-db test:                Tests   1 passed (1)
packages/workspace-picker test:          Tests  10 passed (10)
packages/session-persistence-rdb test:   Tests 129 passed | 24 skipped (153)
packages/sandbox-daemon test:            Tests  36 passed (36)
packages/fs-k8s test:                    Tests  53 passed (53)
packages/workspace-k8s test:             Tests 253 passed (253)
packages/subprocess-k8s test:            Tests  16 passed (16)
=== TEST EXIT 0 ===
```

**566 passed, 24 skipped (PostgreSQL-gated), 0 failed, 0 load failures.** The
pre-change baseline measured on `9de5d8e` is 555 passed with the same 24 skips
(`.superpowers/sdd/plan10-report.md` §4.3), so the delta is exactly the 11 new
fs-k8s cases (42 → 53) and nothing else moved.

### 6.4 `bash scripts/harness-profile.sh /home/ovizro/Code/.tmp-plan11/harness-final`

```
ok   @visecy/dsh-logging-stdout
ok   @visecy/dsh-fs-k8s
ok   @visecy/dsh-subprocess-k8s
ok   @visecy/dsh-workspace-k8s
ok   @visecy/dsh-session-persistence-rdb
ok   @visecy/dsh-storage-db
ok   @visecy/dsh-platform-domain
ok   @visecy/dsh-workspace-picker
ok   @visecy/dsh-identity-bridge

check-plugin-imports: all 9 plugins import cleanly from …/profiles/web
ok   official CLI refuses --host 0.0.0.0 (exit 1): error: --host 0.0.0.0 is intentionally not supported yet for safety: it would expose remote code execution to the network; use 127.0.0.1 instead
harness ready: /home/ovizro/Code/.tmp-plan11/harness-final
=== harness exit 0 ===
```

### 6.5 `node scripts/check-plugin-imports.mjs <profile>`

```
check-plugin-imports: all 9 plugins import cleanly from …/harness-final/home/profiles/web
check-plugin-imports: all 7 plugins import cleanly from …/harness-final/home/profiles/headless
```

### 6.6 `node scripts/smoke-zero-patch.mjs --target <profile>/node_modules`

```
ok   [string guard] official connection has no cookie-layer bypass (deleted patch P2)
ok   [string guard] official connection has no isLoopback pin (deleted patch P1)
ok   [string guard] official webserver carries no registerGate fork extension
ok   1a. __DSH_TRANSPORT__ is injected through webserver/index-inject
ok   2. cookieless GET / is a 302 handoff
ok   3a. the launch token is exchanged with a 303
ok   3d. clean GET / with the cookie renders the index (200)
ok   4a. /api without the cookie is refused 401
ok   4b. the same /api request with the cookie passes the official fence (404, not 401)
ok   5a. ctx.dshAuth.currentUser reads x-forwarded-user / x-forwarded-groups
ok   fence: a foreign Host never receives the launch token (403)
ZERO-PATCH SMOKE OK: the unpatched official composition serves the platform auth path
=== smoke-zero exit 0 ===
```

### 6.7 `node scripts/smoke-official-integration.mjs --target <profile>/node_modules`

```
OFFICIAL-INTEGRATION SMOKE OK: both patches have a supported replacement, and identity-bridge uses it
=== smoke-official exit 0 ===
```

### 6.8 The real conversation

See §5.2 (pre-fix: `TURN FAILED: path escapes workspace root: /.git`) and
§5.3/§5.4 (post-fix: `TURN COMPLETED: {"kind":"completed"}`, once with an
unregistered workspace and once with a registered workspace plus a real pod).

---

## 7. Acceptance steps for a real browser (CDP), post-deploy

Deploy the image built from this commit, then:

1. **Open a session in a workspace.** Load the app, click a workspace in the
   sidebar (e.g. `agents`), then 新会话. The composer appears; do not use the
   "Ungrouped"/hero composer.
2. **Send a message.** Type e.g. `你好` and press Enter (or the send button).
3. **Assert the turn completed** — an assistant reply appears in the transcript
   and the composer returns to idle. A failure here renders as an inline red
   error inside the conversation, which is exactly what the operator saw.

Then, over CDP (`Runtime.evaluate`), assert the two things that must be true:

```js
// 1. the platform failure is gone from the rendered transcript AND the console
document.body.innerText.includes('path escapes workspace root')          // MUST be false
document.body.innerText.includes('is not a registered workspace')        // MUST be false
// 2. the turn really produced a reply (the transcript is not merely empty)
document.body.innerText.trim().length > 0                                // MUST be true
```

And on the control plane, one line per path per process — not per message, and
never a created volume:

```bash
NS=dsh-platform
kubectl -n "$NS" logs deploy/dsh-control-plane-dsh-control-plane -c dsh-web | grep 'fs-k8s:'
#   → exactly one line each for
#     '/workspaces/.git is outside every workspace of this platform ('.git' is not registered under /workspaces)'
#     '/.git is outside the workspace root /workspaces of this platform and names no workspace'
#     '/home/node/.dsh/AGENTS.md is outside the workspace root /workspaces of this platform and names no workspace'

kubectl -n "$NS" get pvc | grep -E '\.git|agents-local-md'                # MUST be empty
```

Send a **second** message in the same session afterwards: it must complete too
(the walk runs on every turn), and the `fs-k8s:` lines must **not** grow — the
once-per-path rule is part of the fix.

Dotfile regression check (what 7b536ea fixed, and what must not break again):
inside the same session, ask for a dotfile that lives in the workspace
(`读取 .gitignore 的内容`, or create `.git/HEAD` in the workspace pod and read
it). It must be served as an ordinary file, with no `fs-k8s:` warn line.

---

## 8. Concerns and open items

1. **`dsh --profile headless` cannot run against this deployment at all**, for a
   reason adjacent to this bug but not the same one: the headless app resolves
   its cwd with `fs.processPath(await fs.resolve("."))`
   (`dsh-headless/lib/index.js:315`), and `FsK8s.resolve` does not give a
   relative path a base, so it throws `path escapes workspace root: .` before
   the first message. Reproduced:

   ```
   $ cd .tmp-plan11/ws/agents && dsh --profile headless --patch …/local.yml "hello"
   dsh: path escapes workspace root: .
   dsh: warning: 6 entries did not activate
   ```

   The official seam's contract is `resolve(path, {cwd})` with the base supplied
   by the caller (`dsh-fs-local/lib/index.js:782`: `opts?.cwd ?? this.config.cwd`),
   so `fs-k8s` is contract-incomplete here. I did **not** change it: making
   `resolve('.')` fall back to `process.cwd()` would resolve to the control
   plane's own `/app`, which is outside `hostRoot` too, so the headless app
   would still have no workspace to run in — the missing piece is a way to name
   a workspace, not the base. It is a real, separate defect (a shipped profile
   that cannot start), and it deserves its own change.
2. **Two more official callers hit the same out-of-root path on every turn** and
   survive only because they catch broadly (§2): `dsh-agent-instructions`
   `fsStatFile` (blanket `catch` at :443) and `dsh-skill-filesystem`
   `pathExistsInFileSystem` (blanket `catch` at :823). Any future tightening of
   those catches would resurface this failure through a different probe. That is
   an upstream observation, not something this repo can fix.
3. **`hostRoot` on the local reproduction is `/tmp`, not `/workspaces`** — the
   sandbox cannot create a top-level `/workspaces`. The escape string is
   therefore `path escapes workspace root: /.git` (identical, because `/tmp` is
   also one segment and `/` is its parent), but the *other* degraded paths in
   the log read `/tmp/...`. The registered-workspace run (§5.4) and the live
   cluster's own `t_sessions.f_cwd` evidence (§1) are what tie this back to
   `/workspaces/<id>`.
4. **`workspace-changes` is disabled in this profile**, so the brief's
   "workspace-changes family" candidate could not fire even in principle; its
   `.git` references are local-git, not `ctx.fs`. If it is ever re-enabled, it
   reads host bytes with `node:fs` and will not use any of this.
5. **The verification database is disposable.** All local runs wrote to the
   throwaway `verify-db` in `dsh-verify`; it was reset with
   `DROP SCHEMA public CASCADE` between runs, and the `agents` pod/PVC it
   created were deleted. No production namespace was written to: the
   `dsh-platform` namespace was only read (`t_sessions`, pod listings, pod exec).
6. **The `analyze` of "why now"**: the operator's turn had been failing on
   `/workspaces/.git` before 7b536ea and on `/.git` after it. That is not a
   regression introduced by 7b536ea — it is the same defect, one dirname level
   further along, which is why the fix had to land at the classification rather
   than at the next probe.
