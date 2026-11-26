/* eslint-disable no-unused-expressions */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { expect } from 'chai';

import {
  addAccount,
  BACKGROUND_ARG,
  forgetAccount,
  getSelectedAccount,
  isBackgroundLaunch,
  listAccounts,
  markAccountUsed,
  PROFILE_ARG_PREFIX,
  readRegistry,
  renameAccount,
  resetAccountsModuleForTesting,
  resolveSelectedAccount,
  storageProfileFor,
  updateAccountMeta,
  userDataPathFor,
} from '../../../../node/config/profiles';

/**
 * The account registry decides which data directory - and so which database and keys - a Session
 * process opens. These tests pin the properties the multi-account design depends on, so an
 * upstream merge cannot quietly break them.
 */
describe('multi-account registry (profiles)', () => {
  let appData: string;
  const savedEnv = { ...process.env };
  const savedArgv = [...process.argv];

  function launchAs(
    env: { NODE_ENV?: string; NODE_APP_INSTANCE?: string },
    argv: Array<string> = []
  ) {
    process.env.NODE_ENV = env.NODE_ENV;
    if (env.NODE_APP_INSTANCE === undefined) {
      delete process.env.NODE_APP_INSTANCE;
    } else {
      process.env.NODE_APP_INSTANCE = env.NODE_APP_INSTANCE;
    }
    delete process.env.SESSION_PROFILE;
    process.argv = [...savedArgv, ...argv];
    resetAccountsModuleForTesting(appData);
  }

  function registryFile() {
    return fs.readdirSync(appData).find(f => f.startsWith('Session-accounts'));
  }

  beforeEach(() => {
    appData = fs.mkdtempSync(path.join(os.tmpdir(), 'session-accounts-test-'));
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    process.argv = [...savedArgv];
    fs.rmSync(appData, { recursive: true, force: true });
  });

  it('keeps an existing packaged install on the directory Session always used', () => {
    launchAs({ NODE_ENV: 'production' });
    const account = getSelectedAccount();

    expect(account.id).to.equal('default');
    expect(account.isDefault).to.be.true;
    expect(storageProfileFor(account)).to.equal('');
    expect(userDataPathFor(account)).to.equal(path.join(appData, 'Session'));
    expect(registryFile()).to.equal('Session-accounts.json');
  });

  it('keeps a dev instance on its own directory and its own registry', () => {
    launchAs({ NODE_ENV: 'development', NODE_APP_INSTANCE: '3' });
    const account = getSelectedAccount();

    expect(storageProfileFor(account)).to.equal('development-3');
    expect(userDataPathFor(account)).to.equal(path.join(appData, 'Session-development-3'));
    expect(registryFile()).to.equal('Session-accounts-development-3.json');
  });

  it('gives every added account its own data directory', () => {
    launchAs({ NODE_ENV: 'production' });
    const first = getSelectedAccount();
    const second = addAccount();
    const third = addAccount('Work');

    const dirs = [first, second, third].map(userDataPathFor);
    expect(new Set(dirs).size).to.equal(3);
    expect(userDataPathFor(second)).to.equal(path.join(appData, `Session-acct-${second.id}`));
    expect(second.isDefault).to.be.false;
    expect(second.label).to.equal('Account 2');
    expect(third.label).to.equal('Work');
  });

  it('selects the account named by --profile=, then SESSION_PROFILE, then the active one', () => {
    launchAs({ NODE_ENV: 'production' });
    const second = addAccount();
    const third = addAccount();

    launchAs({ NODE_ENV: 'production' }, [`${PROFILE_ARG_PREFIX}${second.id}`]);
    expect(resolveSelectedAccount().id).to.equal(second.id);

    launchAs({ NODE_ENV: 'production' });
    process.env.SESSION_PROFILE = third.id;
    expect(resolveSelectedAccount().id).to.equal(third.id);

    launchAs({ NODE_ENV: 'production' });
    markAccountUsed(second.id);
    expect(resolveSelectedAccount().id).to.equal(second.id);

    launchAs({ NODE_ENV: 'production' }, [`${PROFILE_ARG_PREFIX}no-such-account`]);
    expect(resolveSelectedAccount().id).to.equal(second.id);
  });

  it('never changes which account this process is once resolved', () => {
    launchAs({ NODE_ENV: 'production' });
    const me = getSelectedAccount();
    const other = addAccount();
    markAccountUsed(other.id);

    expect(getSelectedAccount().id).to.equal(me.id);
  });

  it("reads the registry from disk, so another process's new account is never erased", () => {
    launchAs({ NODE_ENV: 'production' });
    const me = getSelectedAccount();

    // another process adds an account by rewriting the shared file
    const file = path.join(appData, 'Session-accounts.json');
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
    onDisk.accounts.push({
      ...onDisk.accounts[0],
      id: 'fromelsewhere',
      isDefault: false,
      label: 'X',
    });
    fs.writeFileSync(file, JSON.stringify(onDisk));

    expect(listAccounts().map(a => a.id)).to.include('fromelsewhere');

    // this (older) process then reports its identity: a whole-object write
    updateAccountMeta(me.id, { sessionId: '05abc', displayName: 'Alice' });
    expect(readRegistry().accounts.map(a => a.id)).to.include('fromelsewhere');
  });

  it('labels an account from its display name only until the user names it', () => {
    launchAs({ NODE_ENV: 'production' });
    const second = addAccount();
    updateAccountMeta(second.id, { displayName: 'Bob' });
    expect(listAccounts().find(a => a.id === second.id)?.label).to.equal('Bob');

    renameAccount(second.id, 'Personal');
    updateAccountMeta(second.id, { displayName: 'Robert' });
    const entry = listAccounts().find(a => a.id === second.id);
    expect(entry?.label).to.equal('Personal');
    expect(entry?.displayName).to.equal('Robert');
  });

  it('forgets an account without deleting its data, and never forgets the default one', () => {
    launchAs({ NODE_ENV: 'production' });
    const first = getSelectedAccount();
    const second = addAccount();
    const dataDir = userDataPathFor(second);
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'db.sqlite'), 'keep me');

    expect(forgetAccount(first.id).removed).to.be.false;

    const result = forgetAccount(second.id);
    expect(result).to.deep.equal({ removed: true, dataDir });
    expect(listAccounts().map(a => a.id)).to.deep.equal([first.id]);
    expect(fs.readFileSync(path.join(dataDir, 'db.sqlite'), 'utf8')).to.equal('keep me');
  });

  it('does not replace a registry it momentarily cannot parse', () => {
    launchAs({ NODE_ENV: 'production' });
    const second = addAccount();
    const file = path.join(appData, 'Session-accounts.json');
    const good = fs.readFileSync(file, 'utf8');

    fs.writeFileSync(file, '{ truncated');
    expect(listAccounts().map(a => a.id)).to.include(second.id);
    expect(fs.readFileSync(file, 'utf8')).to.equal('{ truncated');

    fs.writeFileSync(file, good);
  });

  it('recognises a background launch', () => {
    launchAs({ NODE_ENV: 'production' });
    expect(isBackgroundLaunch()).to.be.false;
    launchAs({ NODE_ENV: 'production' }, [BACKGROUND_ARG]);
    expect(isBackgroundLaunch()).to.be.true;
  });
});
