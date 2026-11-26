/* eslint-disable no-unused-expressions */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { expect } from 'chai';

import {
  addAccount,
  BACKGROUND_ARG,
  getSelectedAccount,
  markAccountUsed,
  PROFILE_ARG_PREFIX,
  readRegistry,
  renameAccount,
  resetAccountsModuleForTesting,
  resolveSelectedAccount,
  SPAWNED_SIBLING_ARG,
} from '../../../../node/config/profiles';
import {
  buildAccountLaunch,
  buildRelaunchOptions,
  isBackgroundRequest,
  launchAccount,
  markAccountRevealRequested,
  pinAccountForUpdateRelaunch,
  resetAccountProcessStateForTesting,
  shouldHideWindowOnClose,
  shouldShowWindowsWhenCreated,
  spawnDetached,
  trayAccountLabel,
} from '../../../../node/config/account_process';

/**
 * How one account's process starts, restarts and hides another's. Each of these decides which
 * account - which database and keys - a process ends up on, or whether it quietly quits.
 */
describe('multi-account processes (account_process)', () => {
  let appData: string;
  const savedEnv = { ...process.env };
  const savedArgv = [...process.argv];

  beforeEach(() => {
    appData = fs.mkdtempSync(path.join(os.tmpdir(), 'session-accounts-launch-'));
    process.env.NODE_ENV = 'production';
    delete process.env.NODE_APP_INSTANCE;
    delete process.env.SESSION_PROFILE;
    resetAccountsModuleForTesting(appData);
    resetAccountProcessStateForTesting();
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    process.argv = [...savedArgv];
    fs.rmSync(appData, { recursive: true, force: true });
  });

  const parentArgv = [
    '/opt/Session/session-desktop',
    './app',
    '--use-tray-icon',
    `${PROFILE_ARG_PREFIX}parent`,
    BACKGROUND_ARG,
    SPAWNED_SIBLING_ARG,
    '--inspect=9229',
    '--inspect-brk',
    '--remote-debugging-port=9222',
    '--user-data-dir=/somewhere/shared',
  ];

  describe('launching another account', () => {
    it('drops our own and per-process arguments and names the new account', () => {
      const launch = buildAccountLaunch('abc123def456', false, {
        argv: parentArgv,
        execPath: '/opt/Session/session-desktop',
        env: {},
      });
      expect(launch.command).to.equal('/opt/Session/session-desktop');
      expect(launch.args).to.deep.equal([
        './app',
        '--use-tray-icon',
        `${PROFILE_ARG_PREFIX}abc123def456`,
        SPAWNED_SIBLING_ARG,
      ]);
      expect(launch.env.SESSION_PROFILE).to.equal('abc123def456');
    });

    it('drops the empty arguments an AppImage launcher adds, so they do not pile up', () => {
      // upstream's launcher-script.sh passes "" when it does not need --no-sandbox
      const launch = buildAccountLaunch('a', false, {
        argv: ['/tmp/.mount_S/session-desktop-bin', '', '', '--use-tray-icon'],
        execPath: '/tmp/.mount_S/session-desktop-bin',
        env: { APPIMAGE: '/home/u/Session.AppImage' },
      });
      expect(launch.args).to.deep.equal([
        '--use-tray-icon',
        `${PROFILE_ARG_PREFIX}a`,
        SPAWNED_SIBLING_ARG,
      ]);
      const relaunch = buildRelaunchOptions('a', {
        argv: ['/tmp/.mount_S/session-desktop-bin', '', '--use-tray-icon'],
        execPath: '/tmp/.mount_S/session-desktop-bin',
        env: { APPIMAGE: '/home/u/Session.AppImage' },
      });
      expect(relaunch.args).to.deep.equal(['--use-tray-icon', `${PROFILE_ARG_PREFIX}a`]);
    });

    it('marks it background only when asked', () => {
      const facts = { argv: parentArgv, execPath: '/x', env: {} };
      expect(buildAccountLaunch('a', true, facts).args).to.include(BACKGROUND_ARG);
      expect(buildAccountLaunch('a', false, facts).args).to.not.include(BACKGROUND_ARG);
      expect(
        buildAccountLaunch('a', true, facts).args.filter(a => a === BACKGROUND_ARG)
      ).to.have.length(1);
    });

    it('starts the AppImage itself, not the binary inside our own mount', () => {
      const facts = {
        argv: parentArgv,
        execPath: '/tmp/.mount_SessionXYZ/session-desktop',
        env: { APPIMAGE: '/home/u/Apps/Session.AppImage' },
      };
      expect(buildAccountLaunch('a', false, facts).command).to.equal(
        '/home/u/Apps/Session.AppImage'
      );
      expect(buildRelaunchOptions('a', facts).execPath).to.equal('/home/u/Apps/Session.AppImage');
      expect(
        buildAccountLaunch('a', false, { ...facts, env: {} }).command,
        'no APPIMAGE: the running executable'
      ).to.equal('/tmp/.mount_SessionXYZ/session-desktop');
    });

    it('reports a launch that fails to start, without an uncaught exception', async () => {
      const uncaught: Array<unknown> = [];
      const onUncaught = (e: unknown) => uncaught.push(e);
      process.on('uncaughtException', onUncaught);
      try {
        const missing = path.join(appData, 'no-such-executable');
        const result = await spawnDetached(missing, [], process.env);
        expect(result.ok).to.be.false;
        expect((result as { error: string }).error).to.match(/ENOENT/);

        // and through the account-level call the IPC handler uses
        const account = addAccount();
        process.env.APPIMAGE = missing;
        const launched = await launchAccount(account.id, true);
        expect(launched.ok).to.be.false;

        await new Promise(resolve => {
          setImmediate(resolve);
        });
      } finally {
        process.removeListener('uncaughtException', onUncaught);
      }
      expect(uncaught).to.deep.equal([]);
    });

    it('reports a launch that did start', async () => {
      const result = await spawnDetached(process.execPath, ['-e', '0'], process.env);
      expect(result.ok).to.be.true;
    });

    it('refuses to launch an account that is not in the registry', async () => {
      expect((await launchAccount('../x', false)).ok).to.be.false;
      expect((await launchAccount('0123456789ab', false)).ok).to.be.false;
    });
  });

  describe('relaunching this account', () => {
    it('pins this account even when the registry now points at another one', () => {
      const me = getSelectedAccount();
      const other = addAccount();
      markAccountUsed(other.id); // another process became the active account
      expect(readRegistry().activeId).to.equal(other.id);

      const { args } = buildRelaunchOptions(undefined, {
        argv: ['/opt/Session/session-desktop', '--use-tray-icon', `${PROFILE_ARG_PREFIX}stale`],
        execPath: '/opt/Session/session-desktop',
        env: {},
      });
      expect(args).to.deep.equal(['--use-tray-icon', `${PROFILE_ARG_PREFIX}${me.id}`]);
    });

    it('leaves an argument-less updater relaunch pinned to this account', () => {
      const me = getSelectedAccount();
      const other = addAccount();
      pinAccountForUpdateRelaunch();
      markAccountUsed(other.id); // another account became the active one afterwards

      // the updater starts the new version with a copy of our environment and no arguments
      process.argv = [savedArgv[0]];
      resetAccountsModuleForTesting(appData);
      expect(resolveSelectedAccount().id).to.equal(me.id);
    });

    it('comes back on screen, and keeps the flag that stops it fanning out again', () => {
      const { args } = buildRelaunchOptions('abc', {
        argv: ['/exe', BACKGROUND_ARG, SPAWNED_SIBLING_ARG],
        execPath: '/exe',
        env: {},
      });
      expect(args).to.deep.equal([SPAWNED_SIBLING_ARG, `${PROFILE_ARG_PREFIX}abc`]);
    });
  });

  describe('closing and showing windows', () => {
    const base = {
      quitting: false,
      platform: 'linux' as NodeJS.Platform,
      usingTrayIcon: false,
      hasTray: false,
      backgroundLaunch: false,
    };

    it('hides instead of quitting whenever there is a tray or this is a background account', () => {
      expect(shouldHideWindowOnClose(base)).to.be.false;
      expect(shouldHideWindowOnClose({ ...base, platform: 'win32' })).to.be.false;
      expect(shouldHideWindowOnClose({ ...base, hasTray: true })).to.be.true;
      expect(shouldHideWindowOnClose({ ...base, backgroundLaunch: true })).to.be.true;
      expect(shouldHideWindowOnClose({ ...base, usingTrayIcon: 'true-ish config value' })).to.be
        .true;
      expect(shouldHideWindowOnClose({ ...base, platform: 'darwin' })).to.be.true;
    });

    it('quits when the app is quitting, whatever else is true', () => {
      expect(
        shouldHideWindowOnClose({
          quitting: true,
          platform: 'darwin',
          usingTrayIcon: true,
          hasTray: true,
          backgroundLaunch: true,
        })
      ).to.be.false;
    });

    it('keeps a background account hidden until the user asks for it', () => {
      process.argv = [...savedArgv];
      expect(shouldShowWindowsWhenCreated()).to.be.true;

      process.argv = [...savedArgv, BACKGROUND_ARG];
      expect(shouldShowWindowsWhenCreated()).to.be.false;
      markAccountRevealRequested();
      expect(shouldShowWindowsWhenCreated()).to.be.true;
    });

    it('does not reveal a running account for a background start', () => {
      expect(isBackgroundRequest(['/exe', `${PROFILE_ARG_PREFIX}a`, BACKGROUND_ARG])).to.be.true;
      expect(isBackgroundRequest(['/exe', `${PROFILE_ARG_PREFIX}a`])).to.be.false;
    });

    it('labels the tray with this account only once there is more than one', () => {
      const me = getSelectedAccount();
      expect(trayAccountLabel()).to.be.null;
      addAccount();
      renameAccount(me.id, 'Personal');
      expect(trayAccountLabel()).to.equal('Personal');
    });
  });
});
