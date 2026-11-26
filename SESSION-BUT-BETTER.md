# Session, but Better

A fork of [session-foundation/session-desktop](https://github.com/session-foundation/session-desktop)
that stays fully compatible with upstream: same network, same protocol, same database. Unmodified
Session clients talk to it normally.

## Branches

| Branch | What it is |
|---|---|
| `dev` | Exact mirror of upstream `dev`. Never carries our code. Fast-forwarded automatically. |
| `full-screen-chat` | upstream + fullscreen calls and window/screen sharing ([upstream PR #2065](https://github.com/session-foundation/session-desktop/pull/2065)) |
| `multi-account` | upstream + multiple live accounts ([design](docs/TDD-multi-account.md)) |
| `session-but-better` | both features together: **the product** (default branch) |
| `upstream-sync/<branch>` | proposed upstream merges; reviewed and merged as PRs |

Every branch only ever *merges* upstream. Nothing is rebased or force-pushed, so upstream fixes
reach us unchanged and our features stay small, reviewable diffs on top of them.

## Keeping up with upstream

`.github/workflows/upstream-sync.yml` runs every 15 minutes (and on demand from the Actions tab):

1. fast-forwards `dev` to upstream `dev`;
2. merges upstream into `upstream-sync/<branch>` for each branch above (and, for
   `full-screen-chat`, the PR #2065 branch; for `session-but-better`, the two feature branches);
3. builds, runs the unit tests and lints with the same commands as upstream CI;
4. only on a conflict or a failure, a Claude agent resolves it, with upstream behaviour taking
   precedence over ours;
5. opens or updates a PR into the branch. A red result is a draft PR labelled `needs-human`, or an
   issue if nothing could be merged.

Required repository secrets: `SYNC_TOKEN` (a fine-grained PAT for this repo with Contents, Pull
requests and Workflows set to read/write) and `ANTHROPIC_API_KEY` (or `CLAUDE_CODE_OAUTH_TOKEN`).

## Building

Same as upstream: Node from `.nvmrc`, `pnpm` via corepack, then `pnpm install`, `pnpm build`,
`pnpm test`, `pnpm start-prod`.
