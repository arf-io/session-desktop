import { expect } from 'chai';
import { gt } from 'semver';
import { isBetterVersion, releaseNotesUrl } from '../../../../shared/release_notes';

describe('release notes link', () => {
  it('links our versions to our fork', () => {
    expect(releaseNotesUrl('1.18.5-better.2')).to.equal(
      'https://github.com/arf-io/session-desktop/releases/tag/v1.18.5-better.2'
    );
  });

  it('links plain upstream versions upstream', () => {
    expect(releaseNotesUrl('1.18.5')).to.equal(
      'https://github.com/session-foundation/session-desktop/releases/tag/v1.18.5'
    );
  });

  it('recognises only <upstream>-better.<N>', () => {
    expect(isBetterVersion('1.18.5-better.1')).to.equal(true);
    expect(isBetterVersion('1.18.5-better.12')).to.equal(true);
    expect(isBetterVersion('1.18.5')).to.equal(false);
    expect(isBetterVersion('1.18.5-better')).to.equal(false);
    expect(isBetterVersion('1.18.5-beta.1')).to.equal(false);
  });
});

/**
 * The in-app updater compares versions with semver (ts/updater/updater.ts): it only asks GitHub
 * when Session's file server reports a version greater than ours, then installs a release only if
 * its version is greater than ours. These are the orderings our version scheme relies on.
 */
describe('Session, but Better versions and the updater', () => {
  it('orders our point releases on one upstream version', () => {
    expect(gt('1.18.5-better.2', '1.18.5-better.1')).to.equal(true);
    expect(gt('1.18.5-better.10', '1.18.5-better.9')).to.equal(true);
  });

  it('orders a release on a newer upstream above every point release of the older one', () => {
    expect(gt('1.18.6-better.1', '1.18.5-better.42')).to.equal(true);
  });

  it('lets the file-server check through while upstream is on our base version', () => {
    // the file server reports upstream's 1.18.5; we are 1.18.5-better.N, so the check proceeds
    expect(gt('1.18.5', '1.18.5-better.3')).to.equal(true);
  });

  it('never offers an older upstream release to a newer point release', () => {
    expect(gt('1.18.4', '1.18.5-better.1')).to.equal(false);
  });
});
