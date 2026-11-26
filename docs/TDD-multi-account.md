# TDD — Session Desktop: multiple accounts, all of them live

- **Document**: `docs/TDD-multi-account.md`
- **Version**: 1.1
- **Date**: 2026-11-26 (1.0: 2026-09-20)
- **Branch**: `multi-account`
- **Status**: implemented; §5 records what was verified and what was not. 1.1 fixes the
  review findings listed in §5, "Review fixes in 1.1".

---

## 1. Problem statement

Session Desktop holds exactly one account, and the constraint is not in one place:

| Singleton | Where |
|---|---|
| SQLCipher database, attachments, settings | rooted at `app.getPath('userData')` (`ts/node/sql.ts`, `ts/node/config/user_config.ts`) |
| Redux store | one `window.inboxStore` |
| Our identity | one `UserUtils.getOurPubKeyStrFromCache()`, one libsession user config |
| Swarm polling / notifications | one poller per renderer |

A per-environment data directory already exists (`NODE_APP_INSTANCE`), but it is developer
plumbing, not a feature: `ts/node/config.ts` **forces `NODE_APP_INSTANCE = ''` when the app is
packaged**, so a shipped Session can only ever use one directory.

**The goal**: an account switcher, with *all accounts active* — not one live account and several
parked ones.

## 2. Requirements

| ID | Requirement | Verified by |
|---|---|---|
| R1 | A user can register several accounts and move between them from inside the app | V4, V5 |
| R2 | **Every account is live at the same time** — receiving messages and raising notifications even when its window is not the one on screen | V6 |
| R3 | Accounts are fully isolated: separate database, keys, settings, attachments | V2 |
| R4 | An existing install keeps its account, unchanged, with no migration step | V1 |
| R5 | Two processes must never open one account's database | V3 |
| R6 | Selecting an account that is already running brings its window forward rather than starting a second copy | V3, V5 |
| R7 | Removing an account from the list must not destroy its data | design §3.5, unit tests |
| R8 | No account is ever lost from the registry: not by concurrent writers, not by a torn or unparseable file | unit tests (§5, "Review fixes in 1.1") |
| R9 | A process never comes back as a different account when it restarts | unit tests (§5, "Review fixes in 1.1") |

Out of scope, stated rather than silently dropped: a **unified inbox** (one window listing every
account's conversations). That needs the singletons in §1 to become per-account inside a single
process — a rewrite of Session's core, not a feature on top of it.

## 3. Design

### 3.1 One account, one data directory, one process

Since an account *is* a data directory as far as Session is concerned, each account gets its own
directory and its own process. Every account therefore has a real, running Session behind it: its
own poller, its own database, its own notifications. That is what makes "all active" true rather
than a claim.

The cost, stated plainly: N accounts means N processes and N windows, and memory scales with it.
The benefit is that nothing in Session's core has to be made re-entrant for this to be correct.

### 3.2 The registry — `ts/node/config/profiles.ts`

A JSON file beside the data directories (`<appData>/Session-accounts.json`, suffixed per dev
instance) holding `{ version, activeId, accounts[] }`. Each account records its id, label,
`runInBackground`, timestamps, and — once the renderer reports them — its Session ID and display
name.

Directory mapping:

- the **first** account is `isDefault` and resolves to the directory Session already used, which
  is how R4 is satisfied: an existing install finds its account exactly where it left it, and the
  registry is created around it on first run;
- every other account gets `Session-[<base>-]acct-<id>`.

`<base>` is the storage profile Session would have used anyway (empty when packaged), so a dev
instance keeps its own independent set of accounts rather than colliding with another.

This module runs **before** anything reads a config — `ts/node/config/user_config.ts` imports it
to decide `app.setPath('userData', …)` — so it must not import anything that reads a config.

Selection order: `--profile=<id>` → `SESSION_PROFILE` → the registry's `activeId` → the first
account. Only a **foreground** launch updates `activeId`, so an account started in the background
on someone else's behalf cannot change which account opens by default.

**The registry is read from disk on every read, never cached.** With one process per account, a
process that remembered the registry would work from its own start-up snapshot: its switcher would
never show an account added elsewhere, and its next whole-object write would erase accounts added
since — a cross-process lost update, and one that can happen without anyone touching the UI,
because `update-account-meta` writes as soon as a background account finishes loading. The file is
a few hundred bytes and is read on user actions, not in a loop. The last good copy is kept only as
a fallback for *read-only* callers when the file cannot be read at all; no write is ever based on
it.

**Every read-modify-write holds a cross-process lock.** 1.0 argued that atomic rename made a lock
unnecessary at this write frequency. Review showed otherwise: with 4 processes adding accounts at
once, 62 of 100 returned ids were never persisted, because every writer read, modified and renamed
over the others' work — and all of them used the same `.tmp` name. The lock:

- is a directory, `<registry>.lock`, because `mkdir` is atomic and fails with `EEXIST` on every
  platform Session ships on (on Windows a directory being deleted also reports `EPERM`/`EACCES`/
  `EBUSY`, treated as contention);
- holds an owner record `{ pid, at, token }`;
- is broken when its owner pid is dead (`process.kill(pid, 0)`: `ESRCH` dead, `EPERM` alive), when
  it is older than 10 s, or when it has no readable owner record and is older than 2 s. Breaking
  renames it to a unique tombstone first, so two processes cannot both break it, and gives it back
  if somebody took it in between. A writer checks it still owns the lock before its final rename;
- is waited for with a synchronous back-off (`Atomics.wait`, which Electron's main process allows)
  for up to 5 s, then the operation fails visibly.

Each write goes to a per-process tmp name (`<registry>.<pid>-<random>.tmp`), is fsynced and is
renamed into place (retried on Windows' transient `EPERM`/`EBUSY`). When a stale lock is broken,
tmp files left by writers that are no longer alive are deleted.

**Absent, unparseable and unreadable are three different things.**

- *Absent* (`ENOENT`): first run. A default registry is created, under the lock, after re-reading.
- *Unparseable* (bad JSON, no usable `accounts`): retried a few times over ~150 ms. If it is still
  bad, under the lock and after re-reading, the file is **copied** to
  `<registry>.corrupt-<timestamp>` and a registry rebuilt from the data directories that exist is
  renamed over it: the default account first, then every `Session-[<base>-]acct-<id>` directory
  whose id has the generated format, oldest first. Copying rather than moving the bad file means
  there is never a moment with no file, in which another process would see a first run. Labels and
  identities come from this process's last good read where it has one; otherwise the renderer
  reports them again as each account runs. Re-adopted accounts the process did not know come back
  with "Background" off, so a repair does not start a crowd of processes at the next launch. An
  account that had been *forgotten* comes back, because forgetting keeps its data.
- *Unreadable* (permissions, I/O): never written over. Read-only callers use the last good copy if
  there is one; mutations fail.

**Mutations fail visibly.** `addAccount` throws rather than return an id that was never saved;
rename, background toggle, "last used" and identity updates return `false`; forgetting returns a
reason. Every account IPC handler returns a result instead of throwing, and the switcher shows a
toast for each failure. Resolving *this process's* account never throws: if the registry can be
neither read nor created, the process runs the default account, which is the directory stock
Session uses.

**Ids are validated wherever they enter** (registry file, `--profile=`, `SESSION_PROFILE`, IPC):
`[A-Za-z0-9_-]{1,64}`. An entry with any other id is ignored, and an account's data directory is
checked to be a direct child of appData.

Which account *this process is* stays memoized: another process rewriting `activeId` must never
change who we are half way through our own lifetime.

### 3.3 Switching is launching (R6)

Electron's single-instance lock lives in the user-data directory. Because every account has its
own directory, the lock is **per account**, and the two operations collapse into one:

```
switch to account X  ==  spawn($APPIMAGE || process.execPath, [...argv, --profile=X])
```

- X not running → the new process starts it.
- X already running → the new process cannot take X's lock, hands its arguments to the running
  instance (`second-instance`, which calls `showWindow()`), and exits.

No custom IPC bus between accounts is needed, and there is no way to end up with two processes on
one database.

The mechanics live in `ts/node/config/account_process.ts`, so `main_node.ts` only calls in:

- **Arguments.** A sibling inherits our argv minus `--profile=`, `--session-background`,
  `--session-spawned-sibling`, `--inspect*`, `--remote-debugging-port` (two processes cannot share
  a debug port) and `--user-data-dir` (which would put every account on one directory), plus its
  own `--profile=<id>` and `--session-spawned-sibling`, and `--session-background` only when asked.
- **AppImage.** Inside an AppImage `process.execPath` is on this process's FUSE mount, which
  disappears when this process quits, so `$APPIMAGE` is started instead, for siblings and for
  relaunches.
- **Failure is reported.** A spawn failure (`ENOENT`, `EACCES`) arrives as an asynchronous `error`
  event, which with no listener is an uncaught exception in the main process. The launch resolves
  only on `spawn` or `error`, and the switcher shows the error. Ids not in the registry are refused.

**Relaunching keeps the account (R9).** A process started without `--profile=` resolved its
account from `activeId`, which other accounts change. `app.relaunch()` (restart, reset database)
is therefore given this process's argv minus `--profile=` and `--session-background`, plus
`--profile=<this account>`. `--session-spawned-sibling` is kept, so a sibling does not start
fanning out. The updater's relaunch cannot be given arguments: Squirrel.Mac, the NSIS installer
and the AppImage updater each start the app with their own command line. Two pins cover them:

- at start-up each account process sets `SESSION_PROFILE=<its id>` in its own environment, which
  is consulted before `activeId`. The AppImage updater spawns the new AppImage, and the NSIS
  updater its installer, with a copy of that environment. The AppImage one does so *before*
  `before-quit-for-update` fires, so the second pin alone would be too late for it;
- on `before-quit-for-update`, `activeId` is pointed at this account, for Squirrel.Mac, whose
  relaunch does not inherit our environment and happens after this process has exited. Another
  account changing `activeId` in between would still win; that window is not closed. Whether the
  NSIS installer passes its environment on to the app it starts has not been verified.

**R5 required a fix to existing code.** `main_node.ts` only quit on a failed lock when
`NODE_APP_INSTANCE === 0`, an escape hatch so developers could run several copies. With
per-account directories that exemption is both unnecessary (different instances already get
different directories) and unsafe (two processes could open one account's SQLCipher database). It
is removed: a failed lock now always exits. This was **found by testing, not by reading** — see
§5.

### 3.4 "All active" (R2)

Whichever instance the user launched starts every other account marked `runInBackground`, staggered
by 1.5s so N databases do not open at once. Spawned siblings carry `--session-spawned-sibling` and
never fan out again, so there is no spawn storm.

A background account is launched with `--session-background`, which creates its window with
`show: false` and registers the tray icon. It is a complete, running Session — polling,
receiving, notifying — that simply is not in your face. Bringing it forward is the same
"switching is launching" path as everything else.

- **Its password window is not shown either.** A password-protected background account waits,
  locked and not polling, until the user asks for it; `second-instance` then shows its password
  window, and the main window created after unlocking is shown. (`--session-background` stays in
  argv for the life of the process, so "the user has asked for it" is separate state.)
- **A background start never reveals a running account.** When the first instance restarts, it
  fans out again; an account that is already running receives that as `second-instance` with
  `--session-background` in the command line, and ignores it.
- **Closing its window hides it.** Upstream decides hide-or-quit from the tray *setting* or macOS.
  A background account always has a tray icon, so the rule is now: hide when quitting has not been
  requested and (macOS, or the tray setting, or this process has a tray, or this is a background
  launch). Otherwise closing a background account's window on Windows or Linux would quit it.
- **Tray icons say whose they are.** Once there is more than one account, each process's tray
  tooltip reads `Session - <label>` and its menu starts with the label (one optional parameter on
  upstream's `createTrayIcon`).

### 3.5 Removing an account (R7)

"Remove from this list" forgets the account in the registry and **leaves its data directory on
disk**, returning the path so the UI can say where it is. Deleting someone's messages and keys as
a side effect of tidying a list is not a recoverable mistake, so it is not something this feature
does. The current account and the default account cannot be forgotten.

**A running account cannot be forgotten**, because that would leave a live Session no switcher can
reach. Each account process writes `session-account.pid` into its own data directory once it holds
that directory's single-instance lock (never before: a losing second instance would overwrite the
record), and removes it on quit if it is still its own. An account is running if its recorded pid
is this process or answers `process.kill(pid, 0)`. A crash leaves the record behind; if the
operating system has since reused that pid, the account looks running and forgetting is refused
until it is started and quit once. That errs on the safe side. Forgetting checks liveness and then
writes; an account launched in that instant would still be forgotten while running.

### 3.6 UI

- A **people** icon in the left action panel (`data-testid="accounts-section"`) opens the account
  switcher.
- `ts/components/dialog/AccountSwitcherModal.tsx` lists every account with its display name and a
  truncated Account ID, marks the current one "This window", and offers rename, a "Background"
  toggle, "Remove from this list", and "Add account".
- "Add account" registers an account and opens it; the new window starts at Session's normal
  onboarding, where the user creates or restores an account as usual.

### 3.7 Labelling accounts

Only the renderer knows who is signed in. `startReportingAccountIdentity()`
(`ts/util/accounts.ts`, called from the renderer's start-up) subscribes to the store and reports
the Session ID and display name over IPC whenever they change. The registry auto-labels an account
from its display name unless the user has named it themselves.

Deliberately not a React hook: it is a once-per-process side effect, not UI. (It was a hook first;
the React Compiler pass in this repo's build rejected it.)

### 3.8 Strings

English-only constants with `TODO(l10n)`, for the same reason as the call work:
`session-localization` is a separate repository this fork does not own.

## 4. Verification plan

| ID | What | Pass criterion |
|---|---|---|
| V0 | Build, lint, tests | `pnpm build` 0, `pnpm lint` clean, `pnpm test` no new failures |
| V1 | Existing install keeps its account (R4) | first launch after the change opens the same data directory, with the same account |
| V2 | Isolation (R3) | a second account gets its own directory and its own Session ID |
| V3 | No double-open (R5, R6) | launching an already-running account logs that it is already running and exits 0, leaving one process |
| V4 | Switcher lists accounts (R1) | both accounts shown with real display names and Account IDs, current one marked |
| V5 | Switching (R1, R6) | selecting a background account makes its window visible, with no new process |
| V6 | **All active** (R2) | a message sent to an account whose window is hidden, while a *different* account is on screen, arrives at the hidden one |
| V7 | Registry is shared, not per-process (§3.2) | an account added in one window is visible to another **without restarting it**, and an older process writing its identity does not erase it |
| V8 | Forgetting keeps data (R7) | the account leaves the list; its data directory is still on disk |

## 5. Observations

Observed on **2026-09-20**, macOS (Darwin 27.0.0), Electron 40, running throwaway Session accounts
against the real Session network. The app was driven through the Chrome DevTools Protocol and the
Electron main process through the Node inspector, so these are readings, not assertions.

| ID | Result | Evidence |
|---|---|---|
| V0 | **PASS** | build exit 0, lint clean, 961 passing / 0 failing |
| V1 | **PASS** | first launch: `userData: …/Session-production-devprod1 (account default)` — the pre-existing directory — and the registry created itself around it, auto-labelled itself from that account's live display name and Session ID |
| V2 | **PASS** | the second account got its own `Session-…-acct-<id>` directory and its own Session ID, distinct from the first |
| V3 | **PASS** | launching an already-running account: `quitting; this account is already running in another process`, exit 0, one process left for that account |
| V4 | **PASS** | the switcher listed both accounts by display name with truncated Account IDs, the current one badged "This window" |
| V5 | **PASS** | the background account's window read `isVisible: false` from the main process; clicking its row in the switcher flipped it to `isVisible: true`, with no additional process |
| V6 | **PASS** | with one account on screen and another's window hidden, a third account sent "background delivery test" to the hidden one: its instance showed `unreadCount: 1` and that message as its last message |
| V7 | **PASS** | two accounts running; a third added from window A appeared in window B's `get-accounts` without B restarting; B — which had started before that account existed — then wrote its identity, and the third account was still in the registry on disk afterwards |
| V8 | **PASS** | forgetting an account returned `removed: true` with its data directory path, the list dropped to two, and the directory was still present on disk |

### Two real defects found after the first pass

**The registry was cached per process.** `readRegistry()` memoized the file, so each process worked
from its start-up snapshot. Two consequences, neither of which the first round of testing could
have caught because only one window ever opened the switcher: a stale account list, and — because
every mutation writes the whole object — an account added in one window being erased by an older
process's next write. Reads now go to disk; see §3.2 and V7.

**The first duplicate-launch attempt did not exit**: two processes ran against one account's data
Two processes ran against one account's data directory. The cause was the pre-existing
`NODE_APP_INSTANCE !== 0` exemption in the single-instance check (§3.3). Reading the code had not
shown it, because the exemption was harmless when every dev instance had its own directory by
construction. Fixed, and re-verified as V3.

### Not verified, stated plainly

- **Packaged production builds.** All of the above ran from a development build. The packaged path
  is the one where `NODE_APP_INSTANCE` is forced empty, which the design handles explicitly
  (§3.2), but it has not been run.
- **Windows and Linux.** macOS only. `spawn(process.execPath, …)`, the single-instance lock and
  the tray are all cross-platform, but unverified there.
- **Many accounts.** Three accounts at most (plus a further instance as the message sender) were
  run. The staggering in §3.4 is a precaution, not a measured limit.

### Review fixes in 1.1 (2026-11-26)

A code review found these; each was checked against the code before being changed.

| Finding | Fix | Covered by |
|---|---|---|
| A fresh process that could not parse the registry wrote a one-account default over it | §3.2: default only on `ENOENT`; retry, keep a `.corrupt-` copy, rebuild from data directories | `registry_processes_test` (forked fresh process), `profiles_test` (empty, torn and empty-`accounts` files; unreadable file) |
| Concurrent writers lost updates; one shared `.tmp` name | §3.2: lock, per-process tmp names | `registry_processes_test`: 4 processes × 25 adds |
| Writes failed silently and returned unsaved ids | §3.2: mutations throw or return `false`/a reason; IPC and switcher show it | `profiles_test` with `fs.renameSync` stubbed to fail |
| A spawn error crashed the main process; launch always reported success | §3.3: launch resolves on `spawn`/`error` | `account_process_test`: real spawn of a missing executable |
| A relaunch could come back as another account | §3.3: relaunch pins `--profile=` | `account_process_test` with `activeId` moved elsewhere |
| Closing a background account's window on Windows/Linux quit it | §3.4: hide whenever there is a tray or a background launch | `account_process_test` (pure decision) |
| Several tray icons could not be told apart | §3.4: label in tooltip and menu | `account_process_test` (label source) |
| Forgetting a running account orphaned it | §3.5: pid record, refusal | `profiles_test` with a real live child process |
| A background launch showed its password window | §3.4 | `account_process_test` (show decision); see below |
| AppImage siblings ran from the parent's mount | §3.3: `$APPIMAGE` | `account_process_test` |
| `--user-data-dir=` reached siblings | §3.3: stripped | `account_process_test` |

Also found while fixing: a restarted first instance re-launched running background accounts with
`--session-background`, and their `second-instance` handler then showed their windows (§3.4); and
a writer killed mid-write left its tmp file behind (§3.2). Both fixed and tested.

Observed:

- Before the fix, the new cross-process tests failed: `62 of 100 returned ids were never
  persisted`, and a fresh process given a torn registry returned `[ 'default' ]` only.
- After: unit suite 1079 passing / 0 failing (1055 before), build exit 0, lint clean.
- Stress outside the suite: 8 processes × 60 adds, 5 rounds: 480 returned, 0 errors, 0 lost, 481
  on disk, no tmp or lock files left, each round.
- A writer `SIGKILL`ed while holding the lock, with a half-written tmp file: the next writer broke
  the lock, swept the tmp file and saved its account.
- `Atomics.wait` runs in an Electron 40 main process (the lock's back-off).

In the running app (macOS, Electron 40, dev build, `NODE_APP_INSTANCE=smoke`, with a throwaway
home directory so nothing touched a real profile), driving the account IPC over the DevTools
protocol:

- start-up logged `userData: …/Session-development-smoke (account default)` and wrote
  `session-account.pid` with the main process's pid;
- a second identical launch logged `quitting; this account is already running in another
  process`, exited 0 and left the record alone;
- `add-account` returned `{"ok":true,"id":"db77ea96726d","label":"Account 2"}` and started
  `Electron ./app --profile=db77ea96726d --session-spawned-sibling`: the parent's
  `--remote-debugging-port=9333` was not passed on;
- `forget-account` on that running account returned `"That account is still running. Quit it
  first, then remove it."`; `switch-account` with an unknown id and with `../x` returned
  `"No such account."`;
- with `activeId` now pointing at the new account, `restart` from the first window (launched
  without `--profile=`) came back as `Electron ./app --remote-debugging-port=9333
  --profile=default`, and the other account kept running as the same process;
- with `APPIMAGE` pointed at a missing file, `add-account` returned `ok: true` with
  `launchError: "spawn … ENOENT"`, switching returned the same error, and the main process stayed
  up with no uncaught exception;
- SIGTERM removed each process's pid record; no lock or tmp file was left.

Not verified in a running app for 1.1: the close-to-hide behaviour on Windows/Linux, the tray
labels, the password window of a background account, whether a running background account stays
hidden when a restarted first instance fans out again, the updater relaunch, and a real AppImage.
Their decisions are unit-tested as pure functions.

## 6. Backing out

The feature does not move or delete any data, and it can be undone without touching an account.

```
# the registry lives beside the data directories, e.g. on macOS:
#   ~/Library/Application Support/Session-accounts*.json
# deleting it makes Session behave exactly as it did before
# (also beside it, and safe to delete: Session-accounts*.json.corrupt-*, a stale
#  Session-accounts*.json.lock directory; inside each account directory: session-account.pid)
```

Deleting the registry is safe and complete: without it, Session resolves the default account and
therefore the directory it has always used. Any extra per-account directories are left untouched.

```
git checkout dev
git branch -D multi-account
```
