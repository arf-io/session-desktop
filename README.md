# Session, but Better

Session, but Better is a desktop client for the [Session](https://getsession.org) private
messenger. It is built from [session-foundation/session-desktop](https://github.com/session-foundation/session-desktop)
and adds:

- **Fullscreen calls and screen sharing.** Put a call on the whole display, and share a window or
  a screen during it, at the same time.
- **Multiple live accounts.** Several Session accounts at once, each in its own window. All of them
  receive messages and calls, whichever one is on screen.

It stays **fully compatible with upstream Session**: same network, same protocol, same database.
You can message and call anyone on upstream Session, and moving between upstream Session and
Session, but Better keeps your account. Upstream changes are merged automatically, usually within
15 minutes of landing upstream.

> Session, but Better is an independent fork, not a product of the Session Technology Foundation.
> Please report problems with these builds here, not to upstream.

## Download

Releases are on this repository's [Releases page](../../releases), tagged
`v<upstream version>-sbb.<n>` (for example `v1.18.5-sbb.1` is the first Session, but Better
release built on upstream 1.18.5). Builds are provided for:

| Platform                        | Files                       |
| ------------------------------- | --------------------------- |
| Windows x64                     | `.exe` installer            |
| macOS (Apple silicon and Intel) | `.dmg` / `.zip`             |
| Linux x64                       | `.deb`, `.rpm`, `.AppImage` |

**Verifying downloads.** Upstream's releases are GPG-signed by Session's release signer; ours are
not and cannot be. Each release has a `SHA256SUMS.txt`: compare it with
`shasum -a 256 <file>` (macOS/Linux) or `Get-FileHash <file>` (Windows).

**macOS.** Builds are not yet signed with an Apple Developer ID, so the first launch needs
right-click → **Open**, and macOS won't install updates to them automatically.

**Updates.** Installed builds update from this repository's releases, never from upstream, so an
update never replaces Session, but Better with plain Session.

## Using the extra features

- **Fullscreen**: during a call, use the fullscreen button in the call controls. Press **Esc** or
  use the "Exit Full Screen" pill to leave.
- **Screen sharing**: during a call, use the share button and pick a window or screen. On macOS,
  the first share asks for Screen Recording permission. Sharing replaces your camera and restores
  it when you stop.
- **Accounts**: the people icon in the left bar opens the account switcher. "Add account" opens a
  new window with Session's normal sign-up and restore flow. "Background" keeps an account running
  when you start Session. "Remove from this list" never deletes an account's messages; its data
  stays on disk.

## What is different from upstream

Every change is documented, file by file, with its compatibility notes, what was verified and
known limits, in **[docs/MODIFICATIONS.md](docs/MODIFICATIONS.md)**.

## Branches

| Branch               | Contents                                                                                                                                 |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `session-but-better` | **the product**: upstream plus every feature below (default branch)                                                                      |
| `full-screen-chat`   | upstream plus fullscreen calls and screen sharing ([upstream PR #2065](https://github.com/session-foundation/session-desktop/pull/2065)) |
| `multi-account`      | upstream plus multiple live accounts                                                                                                     |
| `dev`                | an exact mirror of upstream `dev`, never modified                                                                                        |
| `upstream-sync/*`    | automated upstream merges awaiting review                                                                                                |

Branches only ever _merge_ upstream; nothing is rebased or force-pushed.
See [docs/MODIFICATIONS.md § Fork infrastructure](docs/MODIFICATIONS.md#3-fork-infrastructure-session-but-better-only)
for how the sync, tagging and release automation work.

## Building from source

The same as upstream (see [CONTRIBUTING.md](CONTRIBUTING.md)):

```sh
git clone --recursive https://github.com/arf-io/session-desktop.git
cd session-desktop            # default branch: session-but-better
# Node version from .nvmrc, pnpm via corepack
corepack enable
pnpm install
pnpm build
pnpm test
pnpm start-prod               # runs against a separate development data directory
```

`pnpm build-release` produces installers for the platform you build on.

## License

GPL-3.0, as upstream; see [LICENSE](LICENSE). Session, but Better builds on the work of the Session
Technology Foundation and the Session contributors.
