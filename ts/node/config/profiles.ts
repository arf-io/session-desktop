/* eslint-disable no-console */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

import { app } from 'electron';

/**
 * Multi-account support.
 *
 * Session keeps one account per *data directory*: the SQLCipher database, the libsession user
 * config, the attachments and the settings are all rooted at `app.getPath('userData')`, and the
 * renderer has a single store and a single snode poller for whichever account that directory
 * holds. Rather than pretending one process can hold several of those, each account gets its own
 * data directory and its own process — so every account is genuinely live at the same time, with
 * its own polling and its own notifications.
 *
 * This module owns the registry of accounts and the mapping from an account to its data
 * directory. It runs *before* anything else touches `userData`, so it must not import anything
 * which reads a config.
 */

export type AccountEntry = {
  /** stable id, also the data-directory suffix for every account but the first */
  id: string;
  /** what the user calls it; defaults to the account's Session display name once known */
  label: string;
  /**
   * The legacy account (`isDefault`) keeps the data directory Session has always used, so an
   * existing install keeps its account when this feature appears.
   */
  isDefault: boolean;
  /** run this account in the background when another one is launched */
  runInBackground: boolean;
  createdAt: number;
  lastUsedAt: number;
  /** filled in by the renderer once the account is logged in; null while it is still onboarding */
  sessionId: string | null;
  displayName: string | null;
};

type Registry = {
  version: 1;
  activeId: string;
  accounts: Array<AccountEntry>;
};

export const PROFILE_ARG_PREFIX = '--profile=';
export const BACKGROUND_ARG = '--session-background';
export const SPAWNED_SIBLING_ARG = '--session-spawned-sibling';

/** Raised when the registry cannot be read or persisted. Callers must surface it, not swallow it. */
export class AccountRegistryError extends Error {}

/**
 * The storage profile Session would use without multi-account: empty for a packaged production
 * build, `<env>[-<NODE_APP_INSTANCE>]` otherwise. Every account's directory is derived from it, so
 * a dev instance keeps its own independent set of accounts.
 */
function getBaseStorageProfile(): string {
  const { NODE_ENV: environment, NODE_APP_INSTANCE: instance } = process.env;
  const isValidInstance = typeof instance === 'string' && instance.length > 0;
  const isProduction = environment === 'production' && !isValidInstance;

  if (isProduction) {
    return '';
  }
  return isValidInstance ? `${environment || ''}-${instance}` : environment || '';
}

let baseStorageProfileCache: string | null = null;

function baseStorageProfile(): string {
  if (baseStorageProfileCache === null) {
    baseStorageProfileCache = getBaseStorageProfile();
  }
  return baseStorageProfileCache;
}

/** only set by unit tests, which run without Electron's `app` */
let appDataOverride: string | null = null;

function appDataPath(): string {
  return appDataOverride ?? app.getPath('appData');
}

/**
 * Unit tests only: point the registry at a scratch appData directory and forget everything this
 * module memoized, so each test starts as a freshly launched process would.
 */
export function resetAccountsModuleForTesting(appData: string) {
  appDataOverride = appData;
  baseStorageProfileCache = null;
  lastKnownRegistry = null;
  selectedAccount = null;
}

function getRegistryPath(): string {
  const base = baseStorageProfile();
  const name = base ? `Session-accounts-${base}.json` : 'Session-accounts.json';
  return path.join(appDataPath(), name);
}

/** the format `newAccountId()` produces; only directories named with one are ever re-adopted */
const GENERATED_ID = /^[0-9a-f]{12}$/;
/**
 * What an id may look like at all. Ids end up in a directory name, so anything that could step out
 * of appData (`/`, `\`, `..`) is refused wherever an id enters: the registry file, argv, IPC.
 */
const VALID_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function isValidAccountId(id: unknown): id is string {
  return typeof id === 'string' && VALID_ID.test(id);
}

function newAccountId(): string {
  return crypto.randomBytes(6).toString('hex');
}

function defaultAccount(now = Date.now()): AccountEntry {
  return {
    id: 'default',
    label: 'Account 1',
    isDefault: true,
    runInBackground: true,
    createdAt: now,
    lastUsedAt: now,
    sessionId: null,
    displayName: null,
  };
}

function defaultRegistry(): Registry {
  const first = defaultAccount();
  return { version: 1, activeId: first.id, accounts: [first] };
}

function sleepSync(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function isPidAlive(pid: unknown): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: it exists, it just is not ours to signal
    return e?.code === 'EPERM';
  }
}

// --- cross-process lock -----------------------------------------------------------------
//
// Every account process read-modify-writes this one file. A directory is the lock because
// `mkdir` is atomic and fails with EEXIST on every platform Session ships on. The owner writes
// `{ pid, at, token }` inside it, so a lock left by a crashed or killed process can be recognised
// and broken: its pid is gone, or it is older than any real critical section (a few ms of I/O).

const LOCK_TIMEOUT_MS = 5000;
/** a lock whose owner is alive is only broken past this age (pid reuse, a hung process) */
const LOCK_STALE_MS = 10000;
/** a lock with no readable owner record (killed between mkdir and write) is broken past this age */
const LOCK_ORPHAN_MS = 2000;

function getLockPath() {
  return `${getRegistryPath()}.lock`;
}

function lockOwnerFile(lockDir: string) {
  return path.join(lockDir, 'owner');
}

type LockOwner = { pid: number; at: number; token: string };

function readLockOwner(lockDir: string): LockOwner | null {
  try {
    const owner = JSON.parse(fs.readFileSync(lockOwnerFile(lockDir), 'utf8'));
    if (owner && typeof owner.token === 'string') {
      return owner;
    }
  } catch (e) {
    // missing or half written: judged by the directory's age instead
  }
  return null;
}

function isContention(code: string | undefined) {
  if (code === 'EEXIST') {
    return true;
  }
  // Windows reports a directory that is being deleted as EPERM/EACCES/EBUSY
  return (
    process.platform === 'win32' && (code === 'EPERM' || code === 'EACCES' || code === 'EBUSY')
  );
}

/**
 * Writers only create temporary files while holding the lock, so a stale lock is the one sign that
 * a writer died mid-write. Remove the temporary files of writers that are no longer alive.
 */
function sweepAbandonedTmpFiles() {
  const registryName = path.basename(getRegistryPath());
  try {
    fs.readdirSync(appDataPath())
      .filter(f => f.startsWith(`${registryName}.`) && f.endsWith('.tmp'))
      .forEach(f => {
        const pid = Number(f.slice(registryName.length + 1).split('-')[0]);
        if (!isPidAlive(pid)) {
          fs.rmSync(path.join(appDataPath(), f), { force: true });
        }
      });
  } catch (e) {
    console.warn('accounts: could not tidy abandoned registry writes', e?.message);
  }
}

/** @returns true if the lock was stale and has been removed (or had already gone) */
function breakLockIfStale(lockDir: string): boolean {
  const owner = readLockOwner(lockDir);
  let stale: boolean;
  if (owner) {
    const age = Date.now() - owner.at;
    stale = !isPidAlive(owner.pid) || age > LOCK_STALE_MS;
  } else {
    let mtime: number;
    try {
      mtime = fs.statSync(lockDir).mtimeMs;
    } catch (e) {
      return true; // released while we looked
    }
    stale = Date.now() - mtime > LOCK_ORPHAN_MS;
  }
  if (!stale) {
    return false;
  }

  // rename first: only one process can move a given directory, so two processes breaking the same
  // stale lock cannot both win, and neither deletes a lock somebody acquired in between
  const tombstone = `${lockDir}-stale-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  try {
    fs.renameSync(lockDir, tombstone);
  } catch (e) {
    return false;
  }
  const moved = readLockOwner(tombstone);
  if (moved && moved.token !== owner?.token) {
    // somebody took the lock between our look and our rename: give it back if we still can
    try {
      fs.renameSync(tombstone, lockDir);
      return false;
    } catch (e) {
      // the slot is taken again; that holder's commit check will notice it lost the lock
    }
  }
  console.warn(
    `accounts: broke a stale registry lock (owner ${owner ? `pid ${owner.pid}` : 'unknown'})`
  );
  fs.rmSync(tombstone, { recursive: true, force: true });
  sweepAbandonedTmpFiles();
  return true;
}

function acquireRegistryLock(): string {
  const lockDir = getLockPath();
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let delay = 2;
  for (;;) {
    try {
      fs.mkdirSync(lockDir);
      const token = `${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
      const owner: LockOwner = { pid: process.pid, at: Date.now(), token };
      try {
        fs.writeFileSync(lockOwnerFile(lockDir), JSON.stringify(owner), 'utf8');
      } catch (e) {
        fs.rmSync(lockDir, { recursive: true, force: true });
        throw new AccountRegistryError(`could not record the registry lock owner: ${e.message}`);
      }
      return token;
    } catch (e) {
      if (e instanceof AccountRegistryError) {
        throw e;
      }
      if (e?.code === 'ENOENT') {
        fs.mkdirSync(path.dirname(lockDir), { recursive: true });
        continue;
      }
      if (!isContention(e?.code)) {
        throw new AccountRegistryError(`could not lock the account registry: ${e.message}`);
      }
    }
    if (breakLockIfStale(lockDir)) {
      continue;
    }
    if (Date.now() > deadline) {
      throw new AccountRegistryError('timed out waiting for the account registry lock');
    }
    sleepSync(delay + Math.floor(Math.random() * delay));
    delay = Math.min(delay * 2, 50);
  }
}

function stillHoldsLock(token: string) {
  return readLockOwner(getLockPath())?.token === token;
}

function releaseRegistryLock(token: string) {
  const lockDir = getLockPath();
  // never remove a lock that was broken and re-taken by somebody else
  if (!stillHoldsLock(token)) {
    return;
  }
  try {
    fs.rmSync(lockDir, { recursive: true, force: true });
  } catch (e) {
    console.error('accounts: could not release the registry lock', e);
  }
}

let heldLockToken: string | null = null;

function withRegistryLock<T>(fn: () => T): T {
  if (heldLockToken) {
    return fn(); // re-entrant within this process
  }
  const token = acquireRegistryLock();
  heldLockToken = token;
  try {
    return fn();
  } finally {
    heldLockToken = null;
    releaseRegistryLock(token);
  }
}

/** Unit tests only: take the lock and keep it (a forked child holds it and is then killed). */
export function acquireRegistryLockForTesting() {
  return acquireRegistryLock();
}

// --- reading ----------------------------------------------------------------------------

type ReadResult =
  | { kind: 'ok'; registry: Registry }
  | { kind: 'absent' }
  | { kind: 'corrupt'; reason: string }
  | { kind: 'unreadable'; reason: string };

function parseRegistry(raw: string): Registry | string {
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return `not JSON: ${e.message}`;
  }
  if (!parsed || !Array.isArray(parsed.accounts)) {
    return 'no accounts array';
  }
  const accounts: Array<AccountEntry> = parsed.accounts.filter((a: any) => {
    const ok = a && isValidAccountId(a.id);
    if (!ok) {
      console.warn('accounts: ignoring a registry entry with an unusable id', a?.id);
    }
    return ok;
  });
  if (!accounts.length) {
    return 'no usable accounts';
  }
  const activeId = accounts.some(a => a.id === parsed.activeId) ? parsed.activeId : accounts[0].id;
  return { version: 1, activeId, accounts };
}

function readRegistryFileOnce(): ReadResult {
  let raw: string;
  try {
    raw = fs.readFileSync(getRegistryPath(), 'utf8');
  } catch (e) {
    if (e?.code === 'ENOENT') {
      return { kind: 'absent' };
    }
    return { kind: 'unreadable', reason: e?.message || String(e) };
  }
  const parsed = parseRegistry(raw);
  return typeof parsed === 'string'
    ? { kind: 'corrupt', reason: parsed }
    : { kind: 'ok', registry: parsed };
}

const READ_ATTEMPTS = 4;

/**
 * Writes are atomic renames, so a torn read should not happen with this code; but an older build,
 * an antivirus scanner or a sync tool might briefly hold or replace the file. Only an answer that
 * survives a few short retries is acted upon.
 */
function readRegistryFile(): ReadResult {
  let result = readRegistryFileOnce();
  for (
    let i = 1;
    i < READ_ATTEMPTS && (result.kind === 'corrupt' || result.kind === 'unreadable');
    i++
  ) {
    sleepSync(25 * i);
    result = readRegistryFileOnce();
  }
  return result;
}

/**
 * Rebuild the registry from the data directories that exist, so that a registry nobody can parse
 * does not orphan an account: the default account first, then every `Session-[<base>-]acct-<id>`
 * directory, oldest first. Labels and identities come back from `known` (this process's last good
 * read) where it has them; otherwise the renderer reports them again once each account runs.
 *
 * An account that was *forgotten* earlier comes back too, because forgetting keeps its data.
 */
function rebuildFromDataDirectories(known: Registry | null): Registry {
  const base = baseStorageProfile();
  const prefix = base ? `Session-${base}-acct-` : 'Session-acct-';
  const knownById = new Map((known?.accounts || []).map(a => [a.id, a]));

  let found: Array<{ id: string; createdAt: number }> = [];
  try {
    found = fs
      .readdirSync(appDataPath(), { withFileTypes: true })
      .filter(d => d.isDirectory() && d.name.startsWith(prefix))
      .map(d => d.name.slice(prefix.length))
      .filter(id => GENERATED_ID.test(id))
      .map(id => {
        let createdAt = Date.now();
        try {
          const stat = fs.statSync(path.join(appDataPath(), `${prefix}${id}`));
          createdAt = stat.birthtimeMs || stat.mtimeMs;
        } catch (e) {
          // keep now
        }
        return { id, createdAt };
      })
      .sort((a, b) => a.createdAt - b.createdAt);
  } catch (e) {
    console.error('accounts: could not list data directories to rebuild the registry', e);
  }

  const first = knownById.get('default') || defaultAccount();
  const accounts: Array<AccountEntry> = [{ ...first, id: 'default', isDefault: true }];
  found.forEach(({ id, createdAt }) => {
    accounts.push(
      knownById.get(id) || {
        id,
        label: `Account ${accounts.length + 1}`,
        isDefault: false,
        runInBackground: false,
        createdAt,
        lastUsedAt: 0,
        sessionId: null,
        displayName: null,
      }
    );
  });
  return { version: 1, activeId: 'default', accounts };
}

function timestampForFileName() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/**
 * Must hold the lock. Reads the file fresh, creating it only when it is genuinely absent and
 * repairing it only when it is genuinely unparseable. Never answers from a cache: whatever this
 * returns may be written straight back.
 */
function loadForUpdate(): Registry {
  const result = readRegistryFile();
  switch (result.kind) {
    case 'ok':
      return result.registry;
    case 'absent': {
      const fresh = defaultRegistry();
      persistRegistry(fresh);
      return fresh;
    }
    case 'corrupt': {
      const registryPath = getRegistryPath();
      const aside = `${registryPath}.corrupt-${timestampForFileName()}`;
      // copy, not move: renaming it away would leave a moment with no file, and a process reading
      // in that moment would take "absent" to mean a first run
      try {
        fs.copyFileSync(registryPath, aside);
      } catch (e) {
        throw new AccountRegistryError(
          `the account registry is unreadable (${result.reason}) and could not be preserved: ${e.message}`
        );
      }
      const rebuilt = rebuildFromDataDirectories(lastKnownRegistry);
      console.error(
        `accounts: the registry was unreadable (${result.reason}); kept it as ${path.basename(aside)} and rebuilt ${rebuilt.accounts.length} account(s) from their data directories`
      );
      persistRegistry(rebuilt);
      return rebuilt;
    }
    case 'unreadable':
    default:
      // permissions, I/O: the contents may be perfectly good, so never write over them
      throw new AccountRegistryError(
        `could not read the account registry: ${(result as any).reason}`
      );
  }
}

/**
 * Last successfully read or written registry. Only a fallback for a *read-only* caller when the
 * file cannot be read at all, never an optimisation, and never the basis of a write: every account
 * is a separate process writing this one file, so a remembered copy is a stale copy.
 */
let lastKnownRegistry: Registry | null = null;

export function readRegistry(): Registry {
  const result = readRegistryFile();
  if (result.kind === 'ok') {
    lastKnownRegistry = result.registry;
    return result.registry;
  }
  if (result.kind === 'unreadable' && lastKnownRegistry) {
    console.error(`accounts: could not read the registry (${result.reason}); using the last copy`);
    return lastKnownRegistry;
  }
  // absent or corrupt: settle it under the lock, where loadForUpdate re-reads first, so a process
  // that got there before us wins and nothing is created or rebuilt twice
  return withRegistryLock(loadForUpdate);
}

// --- writing ----------------------------------------------------------------------------

function renameWithRetry(from: string, to: string) {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (e) {
      // Windows refuses to replace a file another process has open for a moment
      const transient = e?.code === 'EPERM' || e?.code === 'EACCES' || e?.code === 'EBUSY';
      if (process.platform !== 'win32' || !transient || attempt >= 10) {
        throw e;
      }
      sleepSync(10 * (attempt + 1));
    }
  }
}

/** Must hold the lock. Throws AccountRegistryError if the registry was not persisted. */
function persistRegistry(registry: Registry) {
  const registryPath = getRegistryPath();
  // a name of our own: a shared tmp name lets two writers interleave into one file
  const tmp = `${registryPath}.${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeFileSync(fd, JSON.stringify(registry, null, 2), 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    if (heldLockToken && !stillHoldsLock(heldLockToken)) {
      throw new Error('the registry lock was taken over while this write was in progress');
    }
    // write-then-rename so a crash mid-write cannot leave a truncated registry behind
    renameWithRetry(tmp, registryPath);
  } catch (e) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch (cleanupError) {
      // nothing more to do
    }
    console.error(`accounts: could not write ${registryPath}: ${e?.message}`);
    throw new AccountRegistryError(`could not save the account registry: ${e.message}`);
  }
  lastKnownRegistry = registry;
}

/**
 * Replace the registry. Returns false, and leaves the file as it was, if it could not be saved.
 */
export function writeRegistry(registry: Registry): boolean {
  try {
    withRegistryLock(() => persistRegistry(registry));
    return true;
  } catch (e) {
    console.error('accounts: writeRegistry failed', e?.message);
    return false;
  }
}

/**
 * Read-modify-write under the cross-process lock. `update` returns false to say nothing changed,
 * in which case nothing is written. Throws AccountRegistryError if the change was not persisted.
 */
function updateRegistry(update: (registry: Registry) => boolean) {
  withRegistryLock(() => {
    const registry = loadForUpdate();
    if (update(registry)) {
      persistRegistry(registry);
    }
  });
}

// --- accounts and their directories -----------------------------------------------------

/**
 * The `Session-…` directory name for an account. The default account keeps whatever Session
 * already used, which is how an existing install keeps its data.
 */
export function storageProfileFor(account: AccountEntry): string {
  const base = baseStorageProfile();
  if (account.isDefault) {
    return base;
  }
  if (!isValidAccountId(account.id)) {
    throw new AccountRegistryError(
      `refusing an unusable account id: ${JSON.stringify(account.id)}`
    );
  }
  return base ? `${base}-acct-${account.id}` : `acct-${account.id}`;
}

export function userDataPathFor(account: AccountEntry): string {
  const storageProfile = storageProfileFor(account);
  const appData = appDataPath();
  // Electron's own default for an empty profile: appData/<productName>
  const dir = storageProfile
    ? path.join(appData, `Session-${storageProfile}`)
    : path.join(appData, 'Session');
  const relative = path.relative(appData, dir);
  if (
    !relative ||
    relative.startsWith('..') ||
    path.isAbsolute(relative) ||
    relative.includes(path.sep)
  ) {
    throw new AccountRegistryError(`account directory would leave appData: ${dir}`);
  }
  return dir;
}

function accountIdFromArgv(): string | null {
  const arg = process.argv.find(a => a.startsWith(PROFILE_ARG_PREFIX));
  const requested = arg ? arg.slice(PROFILE_ARG_PREFIX.length) : process.env.SESSION_PROFILE;
  return isValidAccountId(requested) ? requested : null;
}

/**
 * Which account this process is running. Resolution order: an explicit `--profile=<id>` (that is
 * how the switcher launches an account), then `SESSION_PROFILE`, then the registry's active id,
 * then the first account.
 */
export function resolveSelectedAccount(): AccountEntry {
  const registry = readRegistry();
  const requested = accountIdFromArgv();

  const found =
    (requested && registry.accounts.find(a => a.id === requested)) ||
    registry.accounts.find(a => a.id === registry.activeId) ||
    registry.accounts[0];

  return found;
}

let selectedAccount: AccountEntry | null = null;

/**
 * Which account *this* process is. Memoized deliberately: another process rewriting `activeId`
 * must never change who we are half way through our own lifetime.
 *
 * Never throws: this runs while `userData` is being decided, and if the registry cannot be read or
 * created the safe answer is the directory stock Session uses.
 */
export function getSelectedAccount(): AccountEntry {
  if (!selectedAccount) {
    try {
      selectedAccount = resolveSelectedAccount();
    } catch (e) {
      console.error('accounts: could not resolve the account; using the default one', e?.message);
      selectedAccount = defaultAccount();
    }
  }
  return selectedAccount;
}

export function isBackgroundLaunch(): boolean {
  return process.argv.includes(BACKGROUND_ARG);
}

export function isSpawnedSibling(): boolean {
  return process.argv.includes(SPAWNED_SIBLING_ARG);
}

// --- is an account running? -------------------------------------------------------------
//
// Each account process records its pid in its own data directory once it holds that directory's
// single-instance lock. A recorded pid that is still alive means the account is running.
// Pid reuse after a crash can make a dead account look alive; that errs on the side of refusing
// to forget it, and starting then quitting that account clears the record.

const PID_FILE = 'session-account.pid';

function pidFileFor(account: AccountEntry) {
  return path.join(userDataPathFor(account), PID_FILE);
}

export function recordAccountProcess(account: AccountEntry = getSelectedAccount()) {
  try {
    const file = pidFileFor(account);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, at: Date.now() }), 'utf8');
  } catch (e) {
    console.error('accounts: could not record this account process', e?.message);
  }
}

export function clearAccountProcessRecord(account: AccountEntry = getSelectedAccount()) {
  try {
    const file = pidFileFor(account);
    const recorded = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (recorded?.pid === process.pid) {
      fs.rmSync(file, { force: true });
    }
  } catch (e) {
    // nothing recorded, or not ours
  }
}

export function isAccountRunning(account: AccountEntry): boolean {
  let recorded: any;
  try {
    recorded = JSON.parse(fs.readFileSync(pidFileFor(account), 'utf8'));
  } catch (e) {
    return false;
  }
  return recorded?.pid === process.pid || isPidAlive(recorded?.pid);
}

// --- registry mutations -----------------------------------------------------------------

export function listAccounts(): Array<AccountEntry> {
  return readRegistry().accounts;
}

/** @returns whether the change was saved */
function tryUpdate(what: string, update: (registry: Registry) => boolean): boolean {
  try {
    updateRegistry(update);
    return true;
  } catch (e) {
    console.error(`accounts: ${what} failed`, e?.message);
    return false;
  }
}

export function markAccountUsed(id: string): boolean {
  return tryUpdate('markAccountUsed', registry => {
    const account = registry.accounts.find(a => a.id === id);
    if (!account) {
      return false;
    }
    account.lastUsedAt = Date.now();
    // eslint-disable-next-line no-param-reassign -- the registry is a fresh read made for this update
    registry.activeId = id;
    return true;
  });
}

/** Throws AccountRegistryError if the account could not be saved: never returns an unsaved id. */
export function addAccount(label?: string): AccountEntry {
  const out: { added?: AccountEntry } = {};
  updateRegistry(registry => {
    const now = Date.now();
    const taken = new Set(registry.accounts.map(a => a.id));
    let id = newAccountId();
    while (taken.has(id)) {
      id = newAccountId();
    }
    const added: AccountEntry = {
      id,
      label: label || `Account ${registry.accounts.length + 1}`,
      isDefault: false,
      runInBackground: true,
      createdAt: now,
      lastUsedAt: 0,
      sessionId: null,
      displayName: null,
    };
    registry.accounts.push(added);
    out.added = added;
    return true;
  });
  if (!out.added) {
    throw new AccountRegistryError('the account was not added');
  }
  return out.added;
}

/** @returns false if there is no such account or the change could not be saved */
export function renameAccount(id: string, label: string): boolean {
  const seen = { found: false };
  const saved = tryUpdate('renameAccount', registry => {
    const account = registry.accounts.find(a => a.id === id);
    seen.found = !!account;
    if (account) {
      account.label = label;
    }
    return seen.found;
  });
  return saved && seen.found;
}

/** @returns false if there is no such account or the change could not be saved */
export function setAccountRunInBackground(id: string, runInBackground: boolean): boolean {
  const seen = { found: false };
  const saved = tryUpdate('setAccountRunInBackground', registry => {
    const account = registry.accounts.find(a => a.id === id);
    seen.found = !!account;
    if (account) {
      account.runInBackground = runInBackground;
    }
    return seen.found;
  });
  return saved && seen.found;
}

export type ForgetResult = { removed: boolean; dataDir: string | null; reason?: string };

/**
 * Forgets an account. Deliberately does NOT delete its data directory: dropping someone's messages
 * and keys because they tidied a list is not a recoverable mistake. The directory is returned so
 * the caller can tell the user where it is.
 *
 * Refuses an account whose process is still running: forgetting it would leave a live Session
 * that no switcher can reach.
 */
export function forgetAccount(id: string): ForgetResult {
  let result: ForgetResult = { removed: false, dataDir: null, reason: 'No such account.' };
  try {
    updateRegistry(registry => {
      const account = registry.accounts.find(a => a.id === id);
      if (!account) {
        return false;
      }
      if (account.isDefault || registry.accounts.length <= 1) {
        result = { removed: false, dataDir: null, reason: 'The first account cannot be removed.' };
        return false;
      }
      if (isAccountRunning(account)) {
        result = {
          removed: false,
          dataDir: null,
          reason: 'That account is still running. Quit it first, then remove it.',
        };
        return false;
      }
      const dataDir = userDataPathFor(account);
      const remaining = registry.accounts.filter(a => a.id !== id);
      // eslint-disable-next-line no-param-reassign -- the registry is a fresh read made for this update
      registry.accounts = remaining;
      if (registry.activeId === id) {
        // eslint-disable-next-line no-param-reassign
        registry.activeId = remaining[0].id;
      }
      result = { removed: true, dataDir };
      return true;
    });
  } catch (e) {
    return { removed: false, dataDir: null, reason: `Could not save the change: ${e?.message}` };
  }
  return result;
}

/** @returns whether the change was saved */
export function updateAccountMeta(
  id: string,
  meta: { sessionId?: string | null; displayName?: string | null }
): boolean {
  return tryUpdate('updateAccountMeta', registry => {
    const account = registry.accounts.find(a => a.id === id);
    if (!account) {
      return false;
    }
    if (meta.sessionId !== undefined) {
      account.sessionId = meta.sessionId;
    }
    if (meta.displayName !== undefined) {
      account.displayName = meta.displayName;
      // only auto-label an account the user has not named themselves
      if (meta.displayName && /^Account \d+$/.test(account.label)) {
        account.label = meta.displayName;
      }
    }
    return true;
  });
}
