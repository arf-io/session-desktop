/**
 * Session, but Better versions look like 1.18.5-better.2 and are released on our fork; a plain
 * upstream version (a development build) has its notes upstream. Session links to a release by
 * its version tag, which only exists in the repository that published it.
 */
const FORK_RELEASES = 'https://github.com/arf-io/session-desktop/releases/tag';
const UPSTREAM_RELEASES = 'https://github.com/session-foundation/session-desktop/releases/tag';

export function isBetterVersion(version: string) {
  return /^\d+\.\d+\.\d+-better\.\d+$/.test(version);
}

export function releaseNotesUrl(version: string) {
  return `${isBetterVersion(version) ? FORK_RELEASES : UPSTREAM_RELEASES}/v${version}`;
}
