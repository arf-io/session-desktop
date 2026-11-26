/* eslint-disable no-unused-expressions */
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { expect } from 'chai';
import Sinon from 'sinon';

import {
  AccountEntry,
  AccountRegistryError,
  addAccount,
  BACKGROUND_ARG,
  clearAccountProcessRecord,
  forgetAccount,
  getSelectedAccount,
  isAccountRunning,
  isBackgroundLaunch,
  listAccounts,
  markAccountUsed,
  PROFILE_ARG_PREFIX,
  readRegistry,
  recordAccountProcess,
  renameAccount,
  resetAccountsModuleForTesting,
  resolveSelectedAccount,
  setAccountRunInBackground,
  storageProfileFor,
  updateAccountMeta,
  userDataPathFor,
  writeRegistry,
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

  function registryPath() {
    return path.join(appData, 'Session-accounts.json');
  }

  function corruptCopies() {
    return fs.readdirSync(appData).filter(f => f.startsWith('Session-accounts.json.corrupt-'));
  }

  function leftovers() {
    return fs.readdirSync(appData).filter(f => f.includes('.tmp') || f.includes('.lock'));
  }

  beforeEach(() => {
    appData = fs.mkdtempSync(path.join(os.tmpdir(), 'session-accounts-test-'));
  });

  afterEach(() => {
    Sinon.restore();
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

  it('writes a default registry only when there is none at all', () => {
    launchAs({ NODE_ENV: 'production' });
    expect(fs.existsSync(registryPath())).to.be.false;
    expect(listAccounts().map(a => a.id)).to.deep.equal(['default']);
    expect(JSON.parse(fs.readFileSync(registryPath(), 'utf8')).accounts[0].id).to.equal('default');
    expect(corruptCopies()).to.deep.equal([]);
  });

  it('a fresh process keeps a torn registry aside and re-adopts every data directory', () => {
    launchAs({ NODE_ENV: 'production' });
    const ids = ['0123456789ab', 'ba9876543210'];
    ids.forEach(id => fs.mkdirSync(path.join(appData, `Session-acct-${id}`)));
    // not ours to adopt: another dev instance's account, and a directory with no valid id
    fs.mkdirSync(path.join(appData, 'Session-development-3-acct-aaaaaaaaaaaa'));
    fs.mkdirSync(path.join(appData, 'Session-acct-notanid'));

    ['', '{ "version": 1, "acc', '{"version":1,"activeId":"x","accounts":[]}'].forEach(torn => {
      fs.writeFileSync(registryPath(), torn);
      corruptCopies().forEach(f => fs.rmSync(path.join(appData, f)));
      launchAs({ NODE_ENV: 'production' }); // no in-memory copy, as a freshly started process

      expect(listAccounts().map(a => a.id)).to.deep.equal(['default', ...ids]);
      const onDisk = JSON.parse(fs.readFileSync(registryPath(), 'utf8'));
      expect(onDisk.accounts.map((a: AccountEntry) => a.id)).to.deep.equal(['default', ...ids]);
      expect(corruptCopies().length, `one preserved copy of ${JSON.stringify(torn)}`).to.equal(1);
      expect(fs.readFileSync(path.join(appData, corruptCopies()[0]), 'utf8')).to.equal(torn);
      expect(leftovers()).to.deep.equal([]);
    });
  });

  it('a running process repairing a torn registry keeps the labels it knew', () => {
    launchAs({ NODE_ENV: 'production' });
    const second = addAccount('Work');
    fs.mkdirSync(userDataPathFor(second));

    fs.writeFileSync(registryPath(), '{ truncated');
    const entry = listAccounts().find(a => a.id === second.id);
    expect(entry?.label).to.equal('Work');
    expect(corruptCopies().length).to.equal(1);
  });

  it('never writes over a registry it is not allowed to read', function unreadableRegistry() {
    if (process.platform === 'win32' || process.getuid?.() === 0) {
      this.skip();
    }
    launchAs({ NODE_ENV: 'production' });
    const second = addAccount();
    const good = fs.readFileSync(registryPath(), 'utf8');
    fs.chmodSync(registryPath(), 0o000);
    try {
      launchAs({ NODE_ENV: 'production' });
      // start-up falls back to the directory stock Session uses, rather than failing
      expect(getSelectedAccount().isDefault).to.be.true;
      expect(() => addAccount()).to.throw(AccountRegistryError);
      expect(renameAccount(second.id, 'x')).to.be.false;
    } finally {
      fs.chmodSync(registryPath(), 0o600);
    }
    expect(fs.readFileSync(registryPath(), 'utf8')).to.equal(good);
    expect(corruptCopies()).to.deep.equal([]);
    expect(leftovers()).to.deep.equal([]);
  });

  it('reports a failed write instead of returning something it never saved', () => {
    launchAs({ NODE_ENV: 'production' });
    const second = addAccount();
    const before = fs.readFileSync(registryPath(), 'utf8');

    Sinon.stub(fs, 'renameSync').throws(Object.assign(new Error('disk full'), { code: 'ENOSPC' }));

    expect(writeRegistry(readRegistry())).to.be.false;
    expect(() => addAccount('never saved')).to.throw(AccountRegistryError, /disk full/);
    expect(renameAccount(second.id, 'never saved')).to.be.false;
    expect(setAccountRunInBackground(second.id, false)).to.be.false;
    expect(markAccountUsed(second.id)).to.be.false;
    expect(updateAccountMeta(second.id, { displayName: 'never saved' })).to.be.false;
    const forgot = forgetAccount(second.id);
    expect(forgot.removed).to.be.false;
    expect(forgot.reason).to.match(/disk full/);

    Sinon.restore();
    expect(fs.readFileSync(registryPath(), 'utf8')).to.equal(before);
    expect(leftovers()).to.deep.equal([]);
    expect(listAccounts().map(a => a.label)).to.not.include('never saved');
  });

  it('refuses to forget an account whose process is still running', async () => {
    launchAs({ NODE_ENV: 'production' });
    const second = addAccount();
    const dataDir = userDataPathFor(second);
    fs.mkdirSync(dataDir, { recursive: true });

    // a real, live process stands in for that account's Session
    const live = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    });
    await new Promise(resolve => {
      live.once('spawn', resolve);
    });
    fs.writeFileSync(path.join(dataDir, 'session-account.pid'), JSON.stringify({ pid: live.pid }));
    try {
      expect(isAccountRunning(second)).to.be.true;
      const refused = forgetAccount(second.id);
      expect(refused.removed).to.be.false;
      expect(refused.reason).to.match(/still running/);
      expect(listAccounts().map(a => a.id)).to.include(second.id);
    } finally {
      const exited = new Promise(resolve => {
        live.once('exit', resolve);
      });
      live.kill('SIGKILL');
      await exited;
    }

    // the same record with its process gone is not "running"
    expect(isAccountRunning(second)).to.be.false;
    expect(forgetAccount(second.id).removed).to.be.true;
  });

  it('records and clears this process as the running copy of its account', () => {
    launchAs({ NODE_ENV: 'production' });
    const me = getSelectedAccount();
    expect(isAccountRunning(me)).to.be.false;
    recordAccountProcess(me);
    expect(isAccountRunning(me)).to.be.true;
    clearAccountProcessRecord(me);
    expect(isAccountRunning(me)).to.be.false;
  });

  it('never maps an account id to a directory outside appData', () => {
    launchAs({ NODE_ENV: 'production' });
    const template = getSelectedAccount();
    ['../x', '../../../../etc', 'a/b', 'a\\b', '..', '.', ''].forEach(id => {
      expect(() => userDataPathFor({ ...template, id, isDefault: false }), id).to.throw(
        AccountRegistryError
      );
    });

    const named = userDataPathFor({ ...template, id: 'default', isDefault: false });
    expect(path.dirname(named)).to.equal(appData);
    expect(userDataPathFor(template)).to.equal(path.join(appData, 'Session'));

    // an id like that in the registry file, argv or IPC is ignored, not followed
    const onDisk = JSON.parse(fs.readFileSync(registryPath(), 'utf8'));
    onDisk.accounts.push({ ...onDisk.accounts[0], id: '../escape', isDefault: false });
    fs.writeFileSync(registryPath(), JSON.stringify(onDisk));
    expect(listAccounts().map(a => a.id)).to.deep.equal(['default']);
    expect(forgetAccount('../escape').removed).to.be.false;

    launchAs({ NODE_ENV: 'production' }, [`${PROFILE_ARG_PREFIX}../escape`]);
    expect(resolveSelectedAccount().id).to.equal('default');
    expect(fs.readdirSync(path.dirname(appData)).filter(f => f === 'escape')).to.deep.equal([]);
  });

  it('recognises a background launch', () => {
    launchAs({ NODE_ENV: 'production' });
    expect(isBackgroundLaunch()).to.be.false;
    launchAs({ NODE_ENV: 'production' }, [BACKGROUND_ARG]);
    expect(isBackgroundLaunch()).to.be.true;
  });
});
