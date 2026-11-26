# Modifications maintained in Session, but Better

This is the complete list of how Session, but Better differs from upstream
[session-foundation/session-desktop](https://github.com/session-foundation/session-desktop) `dev`.
Anything not listed here is upstream's code, unchanged.

**Keep this file current.** Every path that differs from upstream must be named in this document:
`.github/sbb/upstream-sync.sh check-docs` fails the sync otherwise. When you change a feature,
update its section (behaviour, files, compatibility, verification, limits) in the same PR.

Base at the time of writing: upstream `dev` @ `4c0515cba` (v1.18.5).

---

## Compatibility contract

Session, but Better talks to the same Session network as upstream, with the same protocol, the
same database and the same on-disk layout. An unmodified upstream Session client can message and
call a Session, but Better client and see nothing unusual.

- **No protobuf, message, swarm, onion-request or database-schema changes.** `protos/` and the
  SQL migrations are untouched.
- **One additive wire field.** During a call, the WebRTC data-channel status message
  (`{"video": …}`) gains an optional `"screenShare": true|false`. Upstream clients ignore unknown
  JSON fields, so they still see an ordinary video stream. See §1.
- **Same data directory.** The first account uses exactly the directory upstream Session uses, so
  switching between upstream Session and Session, but Better keeps the same account and history.
  See §2.
- **Same app identity and version.** `productName`, `appId` and `package.json` `version` are
  upstream's. Our releases are told apart by their git tag (see [Releases](#releases)).

---

## 1. Fullscreen calls and screen sharing (`full-screen-chat`)

Origin: ARF's calling work, first offered upstream as PR #2015 and then PR #2065. Both are
closed, so the feature is maintained here on `full-screen-chat`, which merges upstream like
every other branch.

### Behaviour

- **Real fullscreen.** A one-to-one call can be put on the whole display, not just the app window.
  The renderer calls `requestFullscreen()` and keeps Redux in step with `fullscreenchange`, so
  Escape, the OS control and other exits can't leave the app thinking it is still fullscreen.
  An "Exit Full Screen (Esc)" pill stays inside the overlay.
- **The window size Session remembers is not changed by a call.** Page-initiated (HTML) fullscreen
  is not persisted, so quitting during a fullscreen call doesn't make Session reopen fullscreen.
- **Share a window or a screen** from Session's own picker (Electron has none), built on
  `desktopCapturer` and `setDisplayMediaRequestHandler`. The shared track replaces the camera on
  the existing WebRTC video sender (`replaceTrack`). No second m-line is added and no renegotiation
  happens, which keeps calls with unmodified clients working. When sharing stops (in Session or
  from the OS "Stop sharing" control), the previous camera is restored. If there was none, the
  peer gets black video.
- **Fullscreen and sharing work together.** The old "any click exits fullscreen" handler is gone,
  and so is "exit fullscreen when the peer's video mutes".
- **macOS:** the first share triggers the Screen Recording permission prompt. If macOS refuses to
  list sources, the picker links to the right System Settings pane.
- `display-capture` is granted only under the same setting calls already require
  (`mediaPermissions`).

### Files

| File                                                        | Change                                                                                         |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `ts/components/calling/CallButtons.tsx`                     | fullscreen and share buttons, labelled, always shown in a call                                 |
| `ts/components/calling/CallInFullScreenContainer.tsx`       | real fullscreen, exit pill, fit-to-frame for shared screens                                    |
| `ts/components/calling/DraggableCallContainer.tsx`          | no exit-fullscreen side effects                                                                |
| `ts/components/calling/InConversationCallContainer.tsx`     | as above                                                                                       |
| `ts/components/calling/ScreenSharePicker.tsx`               | **new**: the source picker                                                                     |
| `ts/components/icon/DropDownAndToggleButton.tsx`            | test id passthrough                                                                            |
| `ts/components/icon/lucide.ts`                              | MINIMIZE, SCREEN_SHARE, SCREEN_SHARE_OFF glyphs                                                |
| `ts/hooks/useVideoEventListener.ts`                         | fixes a listener that dropped every update on first render                                     |
| `ts/mains/main_node.ts`                                     | display-media handler and IPC (via `ts/node/screenShare.ts`); no persisting of HTML fullscreen |
| `ts/node/permissions.ts`                                    | `display-capture` gated on `mediaPermissions`                                                  |
| `ts/node/screenShare.ts`                                    | **new**: main-process source listing and one-shot source grant                                 |
| `ts/react.d.ts`                                             | test ids                                                                                       |
| `ts/session/utils/calling/CallManager.ts`                   | share via `replaceTrack`, camera restore, `screenShare` status field, `splice` bug fix         |
| `ts/session/utils/calling/Silence.ts`                       | no throw when a call has no audio device                                                       |
| `ts/util/screenShare.ts`                                    | **new**: renderer IPC wrapper                                                                  |
| `ts/test/session/unit/calling/call_duck_test.ts`            | **new** tests                                                                                  |
| `ts/test/session/unit/calling/call_video_listeners_test.ts` | **new** tests                                                                                  |
| `ts/test/session/unit/calling/screen_share_picker_test.ts`  | **new** tests                                                                                  |

### Compatibility

- The `screenShare` field is the only wire addition. It is additive, and a receiver that doesn't
  know it still renders the share as ordinary video. **The sync agent must not remove it** when
  resolving conflicts.
- Strings use existing localized keys (`session-localization` is upstream's and unchanged).

### Verified

- Unit tests: 16 new, plus upstream's suite (`pnpm test`).
- Recorded during the original review: two local WebRTC peers in Electron 40, with the receiver showing a
  synthetic shared window, then the prior camera; camera-off returns to black; cancelling keeps
  the call; a late capture after hang-up is discarded; packaged arm64 macOS app launched.
- **On this branch, 2026-11-25** (macOS, Electron 40, the dev build of `session-but-better`): a
  real call between two throwaway accounts over the Session network, each running as its own
  account process (§2).
  - Build, 1071 unit tests and lint are green.
  - Both ends showed the fullscreen and share buttons.
  - Fullscreen covered the whole 1920×1200 display, with the exit pill.
  - Opened from inside fullscreen, the picker stayed in fullscreen and listed real sources.
  - Sharing a window delivered live 1868×1198 video to the other account, while the sharer stayed
    fullscreen.
  - Stopping the share restored the prior camera-off video.
  - Esc left fullscreen and kept the call.
  - Hang-up ended the call on both sides.

### Known limits

- "Quit while in a fullscreen call, then reopen" (the window-config guard) was not
  re-tested on this branch; it was covered in the original review only.
- A share between two physical devices with a real OS-picked window on the current revision is a
  manual check that hasn't been repeated here.
- Calls are one-to-one, as upstream. Group calls are on the backlog.

---

## 2. Multiple live accounts (`multi-account`)

Origin: the account half of closed PR #2015, ported onto current upstream. Design and the
original verification record: [`docs/TDD-multi-account.md`](TDD-multi-account.md).

### Behaviour

- Each account has **its own data directory and its own process**: database, keys, settings,
  attachments, poller and notifications. Every account is live at once, not just the one on screen.
- **Accounts switcher:** a people icon in the left action bar (`data-testid="accounts-section"`)
  lists accounts with display name and truncated Account ID, marks "This window", and offers
  rename (inline), a "Background" toggle, "Remove from this list" and "Add account".
- **Switching is launching.** Electron's single-instance lock is per data directory, so launching
  an account that is already running hands its arguments to that process, which focuses its
  window, and exits.
- Accounts marked **Background** are started, staggered by 1.5 s, by whichever instance the user
  launched. They run with a hidden window and a tray icon.
- **The first account is the directory upstream already uses**, so existing installs keep their
  account with no migration.
- **Removing an account never deletes its data.** The directory is kept and its path is shown.
- Registry: `<appData>/Session-accounts[-<profile>].json`. It is read from disk on every access,
  never cached, so processes can't erase each other's changes.

### Files

| File                                             | Change                                                                                                                                                                             |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ts/node/config/profiles.ts`                     | **new**: account registry, account-to-directory mapping, selection (`--profile=`, `SESSION_PROFILE`, last used)                                                                    |
| `ts/node/config/user_config.ts`                  | sets `userData` from the selected account                                                                                                                                          |
| `ts/mains/main_node.ts`                          | account IPC (`get-accounts`, `switch-account`, `add-account`, …), spawning, background launch; a failed single-instance lock always exits (it used to be exempt for dev instances) |
| `ts/mains/main_renderer.tsx`                     | reports the signed-in identity so the switcher can label accounts                                                                                                                  |
| `ts/util/accounts.ts`                            | **new**: renderer IPC wrappers, identity reporting                                                                                                                                 |
| `ts/components/dialog/AccountSwitcherModal.tsx`  | **new**: the switcher                                                                                                                                                              |
| `ts/components/dialog/ModalContainer.tsx`        | mounts the switcher                                                                                                                                                                |
| `ts/components/leftpane/ActionsPanel.tsx`        | Accounts button                                                                                                                                                                    |
| `ts/state/ducks/modalDialog.tsx`                 | `accountSwitcherModal` state                                                                                                                                                       |
| `ts/state/selectors/modal.ts`                    | `useAccountSwitcherModal`                                                                                                                                                          |
| `ts/react.d.ts`                                  | `accounts-section` test id                                                                                                                                                         |
| `ts/test/session/unit/accounts/profiles_test.ts` | **new**: 10 registry tests                                                                                                                                                         |
| `docs/TDD-multi-account.md`                      | **new**: design and verification record                                                                                                                                            |

### Compatibility

- Nothing leaves the machine: no protocol or network changes. Each account is an ordinary Session
  account. The default account's directory is byte-for-byte what upstream uses.
- Upstream's `NODE_APP_INSTANCE` dev instances keep working, each with its own independent set of
  accounts.

### Verified

- 10 unit tests cover the registry:
  - the legacy directory is kept (packaged and dev);
  - every account is isolated;
  - selection order (`--profile=`, `SESSION_PROFILE`, last used);
  - this process's identity never changes;
  - no cross-process lost update;
  - auto-labels are replaced only until the user renames;
  - removing keeps data;
  - an unreadable registry is not overwritten.
- In the running app, 2026-11-25 (macOS, Electron 40, throwaway profile):
  - the switcher lists accounts with real name and Account ID;
  - inline rename works;
  - "Add account" started a second process on its own directory;
  - relaunching a running account logged `already running` and exited 0, leaving one process per
    account.
- The original record (V1–V8, 2026-09-20) is in the TDD, including message delivery to a hidden
  account.

### Known limits

- Not yet exercised in a **packaged** build, or on Windows or Linux.
- N accounts means N processes and N windows; memory scales with them.
- No unified inbox: that needs per-account singletons inside one process, which would be a core
  rewrite.
- Switcher strings are English only (`TODO(l10n)`), because the strings repository is upstream's.

### Fixes made while porting

- Rename used `window.prompt()`, which Electron doesn't implement. It is now an inline field.
- Pressing Enter in that field closed the switcher, because focus moved to the close button. Fixed.
- Rows now show the account's label, so a rename is visible.

---

## 3. Fork infrastructure (`session-but-better` only)

| File                                  | Purpose                                                                                |
| ------------------------------------- | -------------------------------------------------------------------------------------- |
| `README.md`                           | this fork's README                                                                     |
| `docs/MODIFICATIONS.md`               | this document                                                                          |
| `.github/workflows/upstream-sync.yml` | polls upstream every 15 min; mirror, merge, verify, agent, PR                          |
| `.github/sbb/upstream-sync.sh`        | the sync logic (`mirror`, `prepare`, `check`, `check-docs`)                            |
| `.github/workflows/sbb-release.yml`   | builds Windows, macOS and Linux for a `v*-better` tag and publishes the GitHub Release |
| `.github/workflows/sbb-tag.yml`       | tags every new product version on `session-but-better`                                 |

The feature branches `full-screen-chat` and `multi-account` carry only upstream plus their own
feature, with none of this infrastructure, so each stays a clean candidate for upstream.

### Upstream sync

- `dev` is fast-forwarded to upstream `dev` and never carries our code. If the fork's `dev` ever
  diverges from upstream, the sync refuses to move it.
- For each branch, upstream (plus that branch's other sources) is merged on
  `upstream-sync/<branch>` and verified with upstream CI's own commands: `pnpm build`, `pnpm test`,
  `pnpm lint`, and no files changed by the formatter. This document's coverage is checked too.
- A Claude agent runs **only** on a conflict or a red check. Upstream wins: our features are
  re-applied on top with the smallest change, and wire formats, schema and signalling are never
  changed (the `screenShare` field above is the one sanctioned addition).
- The result is always a PR, never a direct push. A red result becomes a draft labelled
  `needs-human`, or an issue if nothing could be merged.
- Repository secrets: `SYNC_TOKEN` (a fine-grained PAT with Contents, Pull requests and Workflows
  set to read/write; Actions' own token can't push upstream commits that touch workflows) and
  `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`.

### Releases

- **Every version of ours is tagged** with upstream's version tag plus `-better`. The first release
  on upstream 1.18.5 is `v1.18.5-better`; further releases on the same upstream version are
  `v1.18.5-better.2`, `.3`, and so on. `sbb-tag.yml` creates the tag automatically whenever
  `session-but-better` gains code changes (doc-only and CI-only changes are not tagged). Each tag
  is annotated with the upstream base and the feature heads it contains.
- **Where releases live.** [arf-io/session-desktop](https://github.com/arf-io/session-desktop)
  is the public home of Session, but Better: full source, all branches, tags and releases, with
  clean history (every commit of ours authored `Damien Heiser <dc@arf.io>`, with no tool
  attribution). The automation runs only in the repository whose `SBB_AUTOMATION` variable is
  `true`.
- `sbb-release.yml` builds on a new tag:
  - Windows: x64 NSIS installer;
  - macOS: arm64 and x64 DMG and zip;
  - Linux: deb, rpm and AppImage.
    It then attaches everything to the GitHub Release for that tag.
- **The in-app updater points at arf-io/session-desktop.** Release builds set electron-builder's
  update feed at build time (`--config.publish.owner/repo`, default `arf-io/session-desktop`,
  overridable with the `RELEASE_OWNER` / `RELEASE_REPO` repository variables); `package.json` is
  not edited. An installed Session, but Better therefore never "updates" itself to plain upstream
  Session. How an update is found, unchanged from upstream:

  1. Session's file server reports the newest Session version (onion-routed).
  2. Only if it is newer than the running version does electron-updater ask GitHub.
  3. With a plain version like `1.18.5`, electron-updater follows GitHub's **latest release**: the
     newest release that is neither a draft nor a prerelease, whatever its tag is called. It reads
     `latest.yml` / `latest-linux.yml` from that release.

  So releases on arf-io must be published as regular releases, **not prereleases**. An update is
  offered once the `-better` release for the new upstream version is published.

- The binary's version string stays upstream's, with no `-better` suffix inside the app. It isn't sent
  over the network (requests use a fixed User-Agent), but upstream's code compares it locally: the
  updater's release-channel logic (`ts/updater`) and unsupported-message handling
  (`ts/session/unsupported_messages`). Keeping it unchanged keeps that behaviour identical.
  Consequence: two of our releases on the same upstream version don't auto-update to each other.
  Download the newer one by hand.
- **macOS builds are unsigned** until a Developer ID certificate is added (`MAC_CERTIFICATE`,
  `MAC_CERTIFICATE_PASSWORD`, `SIGNING_*` secrets). Unsigned apps open with right-click → Open,
  and macOS won't apply auto-updates to them.

---

## Backlog (not implemented)

- Multi-person chat sessions. Wolf Pup already has a version of this.
- Multi-person video calls. Wolf Pup already has a version of this. Upstream calls are one-to-one
  WebRTC with no mid-call renegotiation, so group calls need a story for unmodified clients.
