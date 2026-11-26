#!/usr/bin/env bash
# Session, but Better — upstream sync.
#
# Brings one of our branches up to date with session-foundation/session-desktop by merging
# (never rebasing, never force-pushing) on a dedicated sync branch, which is then proposed as a PR.
#
#   upstream-sync.sh mirror              fast-forward our `dev` to upstream/dev (pure mirror)
#   upstream-sync.sh prepare <target>    create/advance upstream-sync/<target> and merge its sources
#   upstream-sync.sh check               fail if conflict markers or unmerged paths remain
#   upstream-sync.sh check-docs          fail if a path that differs from upstream is not named in
#                                        docs/MODIFICATIONS.md (skipped where that file is absent)
#
# Sources merged into each target (in order):
#   full-screen-chat    upstream/dev
#   multi-account       upstream/dev
#   session-but-better  upstream/dev, origin/full-screen-chat, origin/multi-account
#
# Writes key=value lines to $GITHUB_OUTPUT (or stdout): status=up-to-date|merged|conflict,
# sync_branch, upstream_sha, sources.
# DRY_RUN=1 never pushes.
set -euo pipefail

UPSTREAM_URL="${UPSTREAM_URL:-https://github.com/session-foundation/session-desktop.git}"
UPSTREAM_BRANCH="${UPSTREAM_BRANCH:-dev}"
MIRROR_BRANCH="${MIRROR_BRANCH:-dev}"
OUT="${GITHUB_OUTPUT:-/dev/stdout}"

log() { printf '[sync] %s\n' "$*" >&2; }
out() { printf '%s=%s\n' "$1" "$2" >>"$OUT"; }
has_ref() { git rev-parse -q --verify "$1^{commit}" >/dev/null; }

fetch_all() {
  git remote get-url upstream >/dev/null 2>&1 || git remote add upstream "$UPSTREAM_URL"
  git fetch --quiet --no-tags upstream "+refs/heads/${UPSTREAM_BRANCH}:refs/remotes/upstream/${UPSTREAM_BRANCH}"
  git fetch --quiet --no-tags --prune origin '+refs/heads/*:refs/remotes/origin/*'
}

cmd_mirror() {
  fetch_all
  local up="refs/remotes/upstream/${UPSTREAM_BRANCH}" ours="refs/remotes/origin/${MIRROR_BRANCH}"
  if [ "$(git rev-parse "$up")" = "$(git rev-parse "$ours")" ]; then
    log "mirror ${MIRROR_BRANCH} already at upstream $(git rev-parse --short "$up")"
    out mirror up-to-date
    return
  fi
  if ! git merge-base --is-ancestor "$ours" "$up"; then
    log "ERROR: origin/${MIRROR_BRANCH} has commits upstream does not; refusing to touch the mirror"
    git log --oneline "$up..$ours" >&2
    exit 1
  fi
  log "fast-forwarding ${MIRROR_BRANCH}: $(git rev-parse --short "$ours") -> $(git rev-parse --short "$up")"
  [ "${DRY_RUN:-0}" = 1 ] || git push origin "$up:refs/heads/${MIRROR_BRANCH}"
  out mirror advanced
}

sources_for() {
  case "$1" in
    full-screen-chat | multi-account) echo "upstream/${UPSTREAM_BRANCH}" ;;
    session-but-better) echo "upstream/${UPSTREAM_BRANCH} origin/full-screen-chat origin/multi-account" ;;
    *) log "unknown target '$1'"; exit 2 ;;
  esac
}

cmd_prepare() {
  local target="$1" sync="upstream-sync/$1"
  fetch_all
  has_ref "origin/$target" || { log "origin/$target does not exist"; exit 1; }

  # Continue an unmerged sync branch (its PR is still open) rather than starting a second one;
  # a sync branch already merged into the target is simply fast-forwarded past.
  local base="origin/$target"
  if has_ref "origin/$sync" && ! git merge-base --is-ancestor "origin/$sync" "origin/$target"; then
    base="origin/$sync"
  fi
  git checkout --quiet -B "$sync" "$base"
  git submodule update --init --recursive --quiet

  local srcs="" s
  [ "$base" = "origin/$target" ] || srcs="origin/$target"
  for s in $(sources_for "$target"); do
    if has_ref "$s"; then srcs="$srcs $s"; else log "source $s missing; skipped"; fi
  done

  out sync_branch "$sync"
  out upstream_sha "$(git rev-parse "upstream/${UPSTREAM_BRANCH}")"
  out sources "${srcs# }"

  local merged=0
  for s in $srcs; do
    if git merge-base --is-ancestor "$s" HEAD; then
      continue
    fi
    log "merging $s ($(git rev-parse --short "$s")) into $sync"
    if ! git merge --no-ff --no-edit -m "Merge $s ($(git rev-parse --short "$s")) into $target" "$s"; then
      log "CONFLICT merging $s"
      git diff --name-only --diff-filter=U >&2 || true
      out status conflict
      out conflict_source "$s"
      return 0
    fi
    git submodule update --init --recursive --quiet
    merged=1
  done

  # nothing new (including: a sync PR is already open and contains everything) -> no-op
  if [ "$merged" = 1 ]; then out status merged; else out status up-to-date; fi
}

cmd_check() {
  local bad=0
  if [ -n "$(git diff --name-only --diff-filter=U)" ]; then
    log "unmerged paths remain:"; git diff --name-only --diff-filter=U >&2; bad=1
  fi
  if git grep -nE '^(<<<<<<<|>>>>>>>) ' -- . ':!*.md' >&2; then
    log "conflict markers remain"; bad=1
  fi
  if [ -e .git/MERGE_HEAD ] || [ -e "$(git rev-parse --git-dir)/MERGE_HEAD" ]; then
    log "a merge is still in progress (MERGE_HEAD present)"; bad=1
  fi
  exit "$bad"
}

cmd_check_docs() {
  local doc=docs/MODIFICATIONS.md missing=0 f
  if [ ! -f "$doc" ]; then
    log "no $doc on this branch; skipping"
    return 0
  fi
  git rev-parse -q --verify "upstream/${UPSTREAM_BRANCH}" >/dev/null || fetch_all
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    if ! grep -qF -- "$f" "$doc"; then
      log "not documented in $doc: $f"
      missing=1
    fi
  done < <(git diff --name-only "upstream/${UPSTREAM_BRANCH}...HEAD")
  [ "$missing" = 0 ] && log "every modified path is documented"
  return "$missing"
}

case "${1:-}" in
  mirror) cmd_mirror ;;
  prepare) cmd_prepare "${2:?target branch}" ;;
  check) cmd_check ;;
  check-docs) cmd_check_docs ;;
  *) echo "usage: $0 mirror | prepare <target> | check | check-docs" >&2; exit 2 ;;
esac
