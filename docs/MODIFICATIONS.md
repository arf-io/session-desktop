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
- **Wayland (GNOME, KDE): the desktop portal picks.** On Linux, when `XDG_SESSION_TYPE` starts
  with `wayland` and `WAYLAND_DISPLAY` is set (the same test WebRTC uses to capture through
  xdg-desktop-portal), `desktopCapturer.getSources()` opens the portal's own dialog and returns
  only the chosen source. Main detects this and tells the renderer (`get-screen-share-mode`).
  In this mode the share button skips Session's picker and calls `getDisplayMedia()` directly. The
  display-media handler asks the portal once (no thumbnails) and grants its source. If the portal
  returns nothing or is cancelled, the share is declined quietly. The frame, user-gesture, audio and
  `mediaPermissions` checks still apply, and the listing and selection IPC refuse, so nothing else
  opens the portal. X11, Windows and macOS keep Session's picker.
- **The camera button during a share.** A share holds the call's only video sender, so no camera
  is live while it runs. The camera button shows the camera that comes back when the share ends.
  Sharing with the camera off therefore shows "off". Pressing the camera button or picking a camera
  from its menu during a share only changes that camera; the share keeps running, and the chosen
  camera starts when the share stops. The local preview keeps showing the shared screen.
- **Declined shares are explained.** If main declines a share the user did not cancel (selection
  older than 5 s or cleared by a navigation, no user gesture, calls permission or macOS Screen
  Recording access withdrawn, a source no longer on offer), it records why
  (`take-screen-share-refusal`), and the renderer shows a toast using existing strings. A cancel
  in the desktop portal records nothing and stays silent.
- **Outgoing share capped at 1920×1080 and 30 fps.** Unmodified peers, often phones, receive the
  share as ordinary camera video. After `getDisplayMedia()` the track gets upper bounds only
  (`width ≤ 1920`, `height ≤ 1080`, `frameRate ≤ 30`), so Chromium scales it down and keeps the
  aspect ratio. If they can't be applied, the share runs uncapped. `contentHint` stays `detail`.
- **One share at a time.** The share button is disabled while a share is starting, so reopening
  the picker can't clear the first share's selection.
- `display-capture` is granted only under the same setting calls already require
  (`mediaPermissions`).

### Files

| File                                                        | Change                                                                                         |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `ts/components/calling/CallButtons.tsx`                     | fullscreen and share buttons, labelled, always shown in a call; portal mode; pending disable   |
| `ts/components/calling/CallInFullScreenContainer.tsx`       | real fullscreen, exit pill, fit-to-frame for shared screens, preview while sharing             |
| `ts/components/calling/DraggableCallContainer.tsx`          | no exit-fullscreen side effects                                                                |
| `ts/components/calling/InConversationCallContainer.tsx`     | as above; preview while sharing                                                                |
| `ts/components/calling/ScreenSharePicker.tsx`               | **new**: the source picker                                                                     |
| `ts/components/icon/DropDownAndToggleButton.tsx`            | test id passthrough                                                                            |
| `ts/components/icon/lucide.ts`                              | MINIMIZE, SCREEN_SHARE, SCREEN_SHARE_OFF glyphs                                                |
| `ts/hooks/useVideoEventListener.ts`                         | fixes a listener that dropped every update on first render                                     |
| `ts/mains/main_node.ts`                                     | display-media handler and IPC (via `ts/node/screenShare.ts`); no persisting of HTML fullscreen |
| `ts/node/permissions.ts`                                    | `display-capture` gated on `mediaPermissions`; handler exported for its test                   |
| `ts/node/screenShare.ts`                                    | **new**: source listing, one-shot grant, Wayland portal mode, refusal reasons                  |
| `ts/react.d.ts`                                             | test ids                                                                                       |
| `ts/session/utils/calling/CallManager.ts`                   | share via `replaceTrack`, camera restore, `screenShare` status field, `splice` bug fix         |
| `ts/session/utils/calling/ScreenShare.ts`                   | **new**: status payload, camera-button rule, refusal toasts, outgoing cap                      |
| `ts/session/utils/calling/Silence.ts`                       | no throw when a call has no audio device                                                       |
| `ts/util/screenShare.ts`                                    | **new**: renderer IPC wrapper, share mode and refusal types                                    |
| `ts/test/components/ScreenShareButton_test.tsx`             | **new** tests                                                                                  |
| `ts/test/session/unit/calling/call_duck_test.ts`            | **new** tests                                                                                  |
| `ts/test/session/unit/calling/call_video_listeners_test.ts` | **new** tests                                                                                  |
| `ts/test/session/unit/calling/permissions_test.ts`          | **new** tests                                                                                  |
| `ts/test/session/unit/calling/screen_share_picker_test.ts`  | **new** tests                                                                                  |
| `ts/test/session/unit/calling/screen_share_state_test.ts`   | **new** tests                                                                                  |

### Compatibility

- The `screenShare` field is the only wire addition. It is additive, and a receiver that doesn't
  know it still renders the share as ordinary video. **The sync agent must not remove it** when
  resolving conflicts. The status message has exactly the keys `video` and `screenShare` (plus
  upstream's separate `hangup` message); still one video track, no renegotiation. The portal
  mode, camera rule, refusal toasts and cap are all local and add nothing to the wire.
- Strings use existing localized keys (`session-localization` is upstream's and unchanged).

### Verified

- Unit tests: 69 new, plus upstream's suite (`pnpm test`). What they cover, and what they
  don't:
  - **Main process (`ts/node/screenShare.ts`), every platform path, with a stubbed
    `desktopCapturer`:** Session's picker (grant once, unknown source, 5 s expiry, late listing,
    macOS access prompt, restricted access). Navigation clears the selection. Audio, no-video,
    wrong-frame, wrong-page and no-gesture requests are declined. Wayland detection. In portal
    mode: grant of `sources[0]` with one `getSources` call and no thumbnails, `null` on empty, on
    throw and after the page went away, and no listing or selection. Every refusal reason, the
    read-once rule, and a quiet portal cancel.
  - **`display-capture` permission:** granted only when `mediaPermissions` is on.
  - **Decision functions CallManager calls (`ScreenShare.ts`):** the status payload keys, the
    remote `screenShare` reading (an unmodified client's status means not sharing; a hangup leaves
    it alone), the camera-button rule, refusal messages and toasts, and the cap constraints on a
    stubbed track.
  - **Share button (rendered):** a portal-mode click starts the share without Session's picker;
    otherwise the picker opens; the button is disabled while a share is pending.
  - **Not covered by unit tests:** CallManager's data-channel and `replaceTrack` wiring itself
    (it needs a real `RTCPeerConnection`, which jsdom lacks). In particular, that a camera chosen
    during a share leaves the share running is only covered through its decision function.
- **Cap, 2026-11-26** (macOS, Electron 40.0.0 / Chromium 144, a scratch Electron script): the same
  constraints on a real `getDisplayMedia()` capture of a 1920×1200 display gave 1728×1080 at 30 fps.
  On canvas tracks, 5120×2880 gave 1920×1080, 1868×1198 gave 1684×1080 and 1200×2400 gave
  540×1080, all at 30 fps instead of 60.
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

- **Packaged builds, macOS and Linux, 2026-11-26** (`1.18.5-better.1`: a macOS arm64 zip and a
  Linux x86_64 AppImage, each on its own throwaway profile): a real call between a Mac account and
  an Arch Linux account in a GNOME 51 Wayland session (native Wayland, PipeWire,
  xdg-desktop-portal-gnome).
  - Messages went both ways, the call connected, and both sides entered fullscreen.
  - **Wayland portal mode:** on Linux our picker did not appear. GNOME's own share dialog chose
    the source, and the Share button stayed disabled until the share ran.
  - **Cap:** the Mac received the Linux screen at 1728x1080, the 1080-line cap with the display's
    aspect kept.
  - **Stopping:** after "Stop sharing" the Mac was back on the black camera-off video.
  - **Found and fixed:** in fullscreen, the fullscreen and share buttons drew a black icon on no
    background, so they were invisible on the black call view. They now share upstream's
    fullscreen button background. GNOME also takes the window out of fullscreen while its share
    dialog is open.
  - **Not exercised here:** sharing from macOS (the test build had no Screen Recording grant),
    Windows, and X11.

### Known limits

- "Quit while in a fullscreen call, then reopen" (the window-config guard) was not
  re-tested on this branch; it was covered in the original review only.
- A share between two physical devices with a real OS-picked window on the current revision is a
  manual check that hasn't been repeated here.
- **Wayland and Windows have not been run on real machines.** Wayland portal mode is covered by
  unit tests with a stubbed `desktopCapturer` only. That the portal's `sources[0]` is accepted by
  `getDisplayMedia()` without a second portal dialog, and how a portal cancel surfaces in Electron
  40, follow Electron's documented pattern but are unverified. On Windows, Session's picker path
  is shared with macOS and X11 but has never been run there.
- The camera-button rule, refusal toasts, cap and pending-disable have not been exercised in a
  real call yet, and the built app was not launched on this revision; only the cap was measured,
  in a scratch script.
- If the calls permission is switched off mid-call, Chromium may refuse `display-capture` before
  Session's handler runs. That records no reason, so the refusal is silent.
- A camera chosen while a share is still starting (picker or portal open) cancels that share. The
  latest choice wins, as before.
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
  launched. They run with a hidden window and a tray icon; closing their window hides it on every
  platform, and a password-protected one waits, locked, without showing its password window until
  it is asked for. Once there are several accounts, each tray icon is labelled with its account.
- **Restarting keeps the account.** `app.relaunch()` pins `--profile=<this account>`. The updater's
  relaunch can't take arguments, so each account process also carries `SESSION_PROFILE=<its id>` in
  its environment (inherited by the AppImage and NSIS updaters), and the registry's last-used
  account is set to this one when an update starts installing (for Squirrel.Mac).
- **The first account is the directory upstream already uses**, so existing installs keep their
  account with no migration.
- **Removing an account never deletes its data.** The directory is kept and its path is shown. An
  account that is still running can't be removed.
- Registry: `<appData>/Session-accounts[-<profile>].json`. It is read from disk on every access and
  changed only under a cross-process lock, so processes can't erase each other's changes. A
  registry that can't be parsed is kept as `.corrupt-<timestamp>` and rebuilt from the account
  directories on disk; it is never replaced by an empty default. Failed changes are shown in the
  switcher.

### Files

| File                                                       | Change                                                                                                                                                                                            |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ts/node/config/profiles.ts`                               | **new**: account registry (locked writes, corrupt-file recovery), account-to-directory mapping, selection (`--profile=`, `SESSION_PROFILE`, last used), running-account record                    |
| `ts/node/config/account_process.ts`                        | **new**: launching, relaunch arguments, hide-or-quit decision, background reveal, tray label, account IPC                                                                                         |
| `ts/node/tray_icon.ts`                                     | optional account label in the tray tooltip and menu                                                                                                                                               |
| `ts/node/config/user_config.ts`                            | sets `userData` from the selected account                                                                                                                                                         |
| `ts/mains/main_node.ts`                                    | calls into `account_process.ts`: account IPC, background launch, relaunch pinning, hide-on-close, tray label; a failed single-instance lock always exits (it used to be exempt for dev instances) |
| `ts/mains/main_renderer.tsx`                               | reports the signed-in identity so the switcher can label accounts                                                                                                                                 |
| `ts/util/accounts.ts`                                      | **new**: renderer IPC wrappers, identity reporting                                                                                                                                                |
| `ts/components/dialog/AccountSwitcherModal.tsx`            | **new**: the switcher                                                                                                                                                                             |
| `ts/components/dialog/ModalContainer.tsx`                  | mounts the switcher                                                                                                                                                                               |
| `ts/components/leftpane/ActionsPanel.tsx`                  | Accounts button                                                                                                                                                                                   |
| `ts/state/ducks/modalDialog.tsx`                           | `accountSwitcherModal` state                                                                                                                                                                      |
| `ts/state/selectors/modal.ts`                              | `useAccountSwitcherModal`                                                                                                                                                                         |
| `ts/react.d.ts`                                            | `accounts-section` test id                                                                                                                                                                        |
| `ts/test/session/unit/accounts/profiles_test.ts`           | **new**: 17 registry tests                                                                                                                                                                        |
| `ts/test/session/unit/accounts/registry_processes_test.ts` | **new**: 3 tests across forked processes                                                                                                                                                          |
| `ts/test/session/unit/accounts/registry_child.ts`          | **new**: the process those tests fork (not a spec)                                                                                                                                                |
| `ts/test/session/unit/accounts/account_process_test.ts`    | **new**: 14 launch, relaunch and window tests                                                                                                                                                     |
| `docs/TDD-multi-account.md`                                | **new**: design and verification record                                                                                                                                                           |

### Compatibility

- Nothing leaves the machine: no protocol or network changes. Each account is an ordinary Session
  account. The default account's directory is byte-for-byte what upstream uses.
- Upstream's `NODE_APP_INSTANCE` dev instances keep working, each with its own independent set of
  accounts.

### Verified

- 34 unit tests (2026-11-26; suite 1079 passing, build and lint green):
  - the legacy directory is kept (packaged and dev);
  - every account is isolated;
  - selection order (`--profile=`, `SESSION_PROFILE`, last used);
  - this process's identity never changes;
  - auto-labels are replaced only until the user renames;
  - removing keeps data, and a running account can't be removed;
  - 4 forked processes adding at once lose nothing (before the fix, 62 of 100 were lost);
  - a writer killed while holding the lock doesn't block the next one;
  - an empty, torn or unparseable registry is kept aside and rebuilt from the account directories,
    and an unreadable one is never written over;
  - a failed write is reported, not hidden;
  - account ids can't reach outside appData;
  - launch arguments, AppImage, spawn failure, relaunch and updater pinning, hide-or-quit and
    background reveal.
- In the running app, 2026-11-26 (macOS, dev build, throwaway home): adding an account spawned it
  without the parent's debug port; a running account couldn't be removed; unknown and `../x` ids
  were refused; a restart after another account became last-used came back with
  `--profile=default`; a missing executable was reported as `ENOENT` with the main process still
  up; pid records were removed on quit.
- In the running app, 2026-11-25 (macOS, Electron 40, throwaway profile):
  - the switcher lists accounts with real name and Account ID;
  - inline rename works;
  - "Add account" started a second process on its own directory;
  - relaunching a running account logged `already running` and exited 0, leaving one process per
    account.
- The original record (V1–V8, 2026-09-20) is in the TDD, including message delivery to a hidden
  account.

- **Packaged AppImage on Arch Linux / GNOME Wayland, 2026-11-26** (throwaway `XDG_CONFIG_HOME`):
  - "Add account" started a second live process through the AppImage file itself (`$APPIMAGE`),
    with its own data directory, and recorded it in the registry.
  - Launching that account again handed over to the running one and exited, leaving one process.
  - A launch without `--profile` opened the most recently used account and started the others in
    the background, as designed.
  - **Found and fixed:** upstream's AppImage launcher passes an empty argument on every start.
    Copied into sibling launches and relaunches, these piled up, one more per launch; they are
    now dropped.

### Known limits

- Not yet exercised in a **packaged** build, or on Windows or Linux. The 2026-11-26 fixes to
  hide-on-close, tray labels, background password windows, the updater relaunch and AppImage
  launches are unit tested but haven't been run in the app.
- On macOS the updater's relaunch comes back as the last-used account, which is set to the updating
  account just before; another account becoming last-used in that moment would win. That the NSIS
  installer passes its environment to the app it starts is unverified.
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

| File                                                                 | Purpose                                                                                  |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `README.md`                                                          | this fork's README                                                                       |
| `docs/MODIFICATIONS.md`                                              | this document                                                                            |
| `.github/workflows/upstream-sync.yml`                                | fallback upstream sync (off unless `SBB_GITHUB_SYNC=true`)                               |
| `.github/sbb/upstream-sync.sh`                                       | the sync logic (`mirror`, `prepare`, `check`, `check-docs`)                              |
| `.github/workflows/sbb-release.yml`                                  | builds Windows, macOS and Linux for a `v*-better.N` tag and publishes the GitHub Release |
| `.github/workflows/sbb-tag.yml`                                      | tags every new product version on `session-but-better`                                   |
| `.github/workflows/sbb-retry.yml`                                    | re-runs release jobs that failed or that GitHub found no runner for                      |
| `.github/sbb/make-universal-mac.cjs`                                 | merges the arm64 and x64 apps into the universal macOS app                               |
| `.github/sbb/load-native-modules.cjs`                                | checks every native module loads, run once per architecture                              |
| `.github/sbb/mac-update-info.sh`                                     | writes `better-mac.yml`, the macOS update feed listing both architectures                |
| `ts/shared/release_notes.ts`                                         | "Release notes" links: our versions open our release, upstream's open upstream's         |
| `ts/test/session/unit/versions/release_notes_test.ts`                | tests the links above and the version ordering the updater relies on                     |
| `ts/mains/main_node.ts`, `ts/components/dialog/debug/components.tsx` | one line each: the Help menu and debug "Release notes" links use `releaseNotesUrl`       |

The feature branches `full-screen-chat` and `multi-account` carry only upstream plus their own
feature, with none of this infrastructure, so each stays a clean candidate for upstream.

### Upstream sync

- `dev` is fast-forwarded to upstream `dev` and never carries our code. If the fork's `dev` ever
  diverges from upstream, the sync refuses to move it.
- For each branch, upstream (plus that branch's other sources) is merged on
  `upstream-sync/<branch>` and verified with upstream CI's own commands: `pnpm build`, `pnpm test`,
  `pnpm lint`, and no files changed by the formatter. This document's coverage is checked too.
- Conflicts and red checks are resolved by an implementing agent and checked by an adversarial
  review from a different model vendor, until the checks pass and the review approves. Upstream
  wins: our features are re-applied on top with the smallest change, and wire formats, schema
  and signalling are never changed (the `screenShare` field above is the one sanctioned
  addition). Commits are authored by Damien Heiser, with no tool attribution.
- The result is always a reviewed PR, never a direct push to our branches.
- The primary sync runs in ARF's private automation, outside this repository.
  `.github/workflows/upstream-sync.yml` is a fallback, run only when the repository variables
  `SBB_AUTOMATION` and `SBB_GITHUB_SYNC` are both `true`. It needs a `SYNC_TOKEN` PAT (Contents,
  Pull requests and Workflows read/write) to open PRs, and `ANTHROPIC_API_KEY` or
  `CLAUDE_CODE_OAUTH_TOKEN` for its agent.

### Releases

- **Versions.** Every release of ours is `v<upstream version>-better.<N>`: `v1.18.5-better.1` is
  our first release on upstream Session 1.18.5, `v1.18.5-better.2` the next, and
  `v1.18.6-better.1` the first once upstream moves to 1.18.6. This is our own release cadence:
  `sbb-tag.yml` tags `session-but-better` whenever it gains code changes (doc-only and CI-only
  changes are not tagged), and a release can be cut by hand by running that workflow. Each tag is
  annotated with the upstream base and the feature heads it contains.
- **The app carries the same version.** Release builds set the app's version from the tag on the
  electron-builder command line (`--config.extraMetadata.version=1.18.5-better.2`); `package.json`
  is not edited. The About screen shows it, and the in-app updater compares it, which is what
  lets an install move up through our point releases. semver orders these versions the way we
  need (pinned by `ts/test/session/unit/versions/release_notes_test.ts`):
  `1.18.5-better.1 < 1.18.5-better.2 < 1.18.6-better.1`. The version isn't sent over the network
  (requests use a fixed User-Agent). Upstream code that reads it locally only checks it for
  equality (unsupported-message reprocessing, the "new version" cleanup), so a different string
  changes nothing there.
- **Where releases live.** [arf-io/session-desktop](https://github.com/arf-io/session-desktop)
  is the public home of Session, but Better: full source, all branches, tags and releases, with
  clean history (every commit of ours authored `Damien Heiser <dc@arf.io>`, with no tool
  attribution). The automation runs only in the repository whose `SBB_AUTOMATION` variable is
  `true`.
- `sbb-release.yml` builds on a new tag:
  - Windows: x64 NSIS installer;
  - macOS: Apple silicon (arm64), Intel (x64) and universal, each as a DMG and a zip;
  - Linux: deb, rpm and AppImage.
    It then attaches everything, with `SHA256SUMS.txt`, to the GitHub Release for that tag and
    publishes it.
- **How the macOS builds are made.** The arm64 and x64 jobs each build only a zip on their own
  hosted runner. A third job (`mac_package`, Apple silicon) takes the two zips and:
  1. merges them into a universal app with `@electron/universal`
     (`.github/sbb/make-universal-mac.cjs`; the script's header explains the four differences it
     evens out between the two builds) and signs it;
  2. loads every native module (libsession, its worker, sqlcipher, sharp) under both arm64 and,
     through Rosetta, x86_64;
  3. makes the three DMGs and the universal zip with electron-builder from the finished apps,
     retrying, with Spotlight indexing off. Building the DMG inside the per-architecture jobs used
     to fail intermittently on the Intel runners (hdiutil: "Resource busy"), and that failure took
     the zip down with it;
  4. writes `better-mac.yml`.
     The universal build is about 1.7 times the size of a single-architecture one (265 MB against
     about 155 MB zipped): the JavaScript is shared, the native code is there twice.
- **Retries.** `sbb-retry.yml` runs whenever a Release or Tag release run ends failed or
  cancelled. A job GitHub could not give a runner (macOS arm64 capacity is the usual case), or
  whose runner died, is re-run after a 10-minute pause, up to 8 attempts of the run. A job that
  failed on its own is re-run once; a second failure is left for a person. A run someone cancelled
  is left alone. Re-running a job re-runs what depends on it, including publishing. On a public
  repository, GitHub-hosted runners cost nothing, and a job that never got a runner uses no time.
- **The in-app updater points at arf-io/session-desktop.** Release builds set electron-builder's
  update feed at build time (`--config.publish.owner/repo`, default `arf-io/session-desktop`,
  overridable with the `RELEASE_OWNER` / `RELEASE_REPO` repository variables). An installed
  Session, but Better therefore never "updates" itself to plain upstream Session. How an update is
  found:

  1. Session's file server reports the newest Session version (onion-routed). The updater asks
     GitHub only if that is newer than the running version. Upstream's `1.18.5` is newer than our
     `1.18.5-better.N`, so while upstream is on our base version the check always goes through;
     no updater code is changed.
  2. Because our version has a prerelease part (`-better.N`), electron-updater reads the
     releases feed and takes the newest release whose tag is also `-better`, then downloads that
     release's `better` channel file: `better.yml` (Windows), `better-mac.yml`,
     `better-linux.yml` (AppImage). The builds write those names because the feed is configured
     with `--config.publish.channel=better`.
  3. It installs that release only if its version is newer than the running one.

  Releases must still be published as regular releases, not drafts or prereleases. On macOS,
  `better-mac.yml` lists the arm64 and x64 zips; the updater picks the zip with `arm64` in its name
  on Apple silicon and the other on Intel. The universal zip is deliberately not listed, so a
  universal install updates to its own architecture's (smaller) build.

- **macOS builds are signed ad hoc** until a Developer ID certificate is added (`MAC_CERTIFICATE`,
  `MAC_CERTIFICATE_PASSWORD`, `SIGNING_*` secrets). They open with right-click → Open, and macOS
  won't apply auto-updates to them: the updater only installs an update signed by the same
  identity as the installed app, and an ad hoc signature has no stable identity. Windows and the
  Linux AppImage update normally.

---

## Backlog (not implemented)

- Multi-person chat sessions. Wolf Pup already has a version of this.
- Multi-person video calls. Wolf Pup already has a version of this. Upstream calls are one-to-one
  WebRTC with no mid-call renegotiation, so group calls need a story for unmodified clients.
