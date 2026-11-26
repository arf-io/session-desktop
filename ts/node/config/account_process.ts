/* eslint-disable no-console */
import { spawn } from 'child_process';

import { autoUpdater, type IpcMain } from 'electron';

import {
  addAccount,
  BACKGROUND_ARG,
  forgetAccount,
  getSelectedAccount,
  isBackgroundLaunch,
  isValidAccountId,
  listAccounts,
  markAccountUsed,
  PROFILE_ARG_PREFIX,
  renameAccount,
  setAccountRunInBackground,
  SPAWNED_SIBLING_ARG,
  updateAccountMeta,
  userDataPathFor,
} from './profiles';

/**
 * How one account's process starts, restarts and hides another's - kept out of main_node.ts so the
 * upstream file only calls in, and so every decision here is a pure function a test can pin.
 */

type ProcessFacts = {
  argv: Array<string>;
  execPath: string;
  env: NodeJS.ProcessEnv;
};

function currentProcessFacts(): ProcessFacts {
  return { argv: process.argv, execPath: process.execPath, env: process.env };
}

/**
 * Inside an AppImage `process.execPath` lives on this process's FUSE mount, which goes away when
 * this process quits. The AppImage file itself (`$APPIMAGE`) is what must be started again.
 */
export function executableFor({ execPath, env }: Pick<ProcessFacts, 'execPath' | 'env'>): string {
  return env.APPIMAGE || execPath;
}

/** arguments of ours that must not be inherited by a different account's process */
function isStrippedForSibling(arg: string) {
  return (
    arg.startsWith(PROFILE_ARG_PREFIX) ||
    arg === BACKGROUND_ARG ||
    arg === SPAWNED_SIBLING_ARG ||
    // two processes cannot share a debug port
    arg.startsWith('--inspect') ||
    arg.startsWith('--remote-debugging-port') ||
    // would map every account onto one data directory
    arg.startsWith('--user-data-dir')
  );
}

export function buildAccountLaunch(
  accountId: string,
  background: boolean,
  facts: ProcessFacts = currentProcessFacts()
): { command: string; args: Array<string>; env: NodeJS.ProcessEnv } {
  const args = [
    ...facts.argv.slice(1).filter(arg => !isStrippedForSibling(arg)),
    `${PROFILE_ARG_PREFIX}${accountId}`,
    SPAWNED_SIBLING_ARG,
  ];
  if (background) {
    args.push(BACKGROUND_ARG);
  }
  return {
    command: executableFor(facts),
    args,
    env: { ...facts.env, SESSION_PROFILE: accountId },
  };
}

/**
 * Options for `app.relaunch()`. A process started without `--profile=` resolved its account from
 * the registry's `activeId`, which other accounts change; relaunching with the original argv could
 * therefore come back as somebody else. Pin this process's own account instead. A restart is
 * something the user asked for on screen, so it does not come back hidden.
 */
export function buildRelaunchOptions(
  accountId: string = getSelectedAccount().id,
  facts: ProcessFacts = currentProcessFacts()
): { args: Array<string>; execPath: string } {
  const args = facts.argv
    .slice(1)
    .filter(arg => !arg.startsWith(PROFILE_ARG_PREFIX) && arg !== BACKGROUND_ARG);
  args.push(`${PROFILE_ARG_PREFIX}${accountId}`);
  return { args, execPath: executableFor(facts) };
}

export type LaunchResult = { ok: true } | { ok: false; error: string };

/**
 * Start a detached process. Failure to start (ENOENT, EACCES) arrives as an asynchronous 'error'
 * event, which would be an uncaught exception in the main process if nobody listened, so this
 * resolves only once the child has either spawned or failed.
 */
export function spawnDetached(
  command: string,
  args: Array<string>,
  env: NodeJS.ProcessEnv
): Promise<LaunchResult> {
  return new Promise(resolve => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, { detached: true, stdio: 'ignore', env });
    } catch (e) {
      resolve({ ok: false, error: e?.message || String(e) });
      return;
    }
    child.once('error', e => {
      resolve({ ok: false, error: e?.message || String(e) });
    });
    child.once('spawn', () => {
      child.unref();
      resolve({ ok: true });
    });
  });
}

/** Start (or, if it is already running, focus) another account's process. */
export async function launchAccount(accountId: string, background: boolean): Promise<LaunchResult> {
  try {
    if (!isValidAccountId(accountId) || !listAccounts().some(a => a.id === accountId)) {
      return { ok: false, error: 'No such account.' };
    }
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
  const { command, args, env } = buildAccountLaunch(accountId, background);
  console.log(`accounts: launching ${accountId}${background ? ' (background)' : ''}`);
  const result = await spawnDetached(command, args, env);
  if (!result.ok) {
    console.error('accounts: failed to launch', accountId, result.error);
  }
  return result;
}

/**
 * Closing the main window hides it, rather than quitting, on macOS (upstream), when the user turned
 * the tray icon on (upstream), and whenever this process has a tray icon at all - which every
 * background account has. Otherwise closing a background account's window on Windows or Linux
 * would quit that account, with nothing on screen to say so.
 */
export function shouldHideWindowOnClose(state: {
  quitting: boolean;
  platform: NodeJS.Platform;
  /** upstream's getStartInTray().usingTrayIcon, which is a raw config value */
  usingTrayIcon: unknown;
  hasTray: boolean;
  backgroundLaunch: boolean;
}): boolean {
  if (state.quitting) {
    return false;
  }
  return (
    state.platform === 'darwin' ||
    Boolean(state.usingTrayIcon) ||
    state.hasTray ||
    state.backgroundLaunch
  );
}

/**
 * A background account keeps its windows hidden until the user asks for it. `--session-background`
 * stays in argv for the life of the process, so "has the user asked for it yet" is its own state.
 */
let revealRequested = false;

export function markAccountRevealRequested() {
  revealRequested = true;
}

/** Unit tests only. */
export function resetAccountProcessStateForTesting() {
  revealRequested = false;
}

export function shouldShowWindowsWhenCreated(): boolean {
  return !isBackgroundLaunch() || revealRequested;
}

/**
 * A second instance launched for a background start (a restarted first instance fanning out
 * again) must not pull an already-running account's window onto the screen.
 */
export function isBackgroundRequest(commandLine: Array<string>): boolean {
  return commandLine.includes(BACKGROUND_ARG);
}

/** What the tray says this process is, so several accounts' tray icons can be told apart. */
export function trayAccountLabel(): string | null {
  try {
    const accounts = listAccounts();
    if (accounts.length < 2) {
      return null; // a single account looks exactly like stock Session
    }
    const me = getSelectedAccount();
    const current = accounts.find(a => a.id === me.id);
    return current?.label || current?.displayName || me.label || null;
  } catch (e) {
    return null;
  }
}

/**
 * Every account the user wants live gets its own process, started once by whichever instance the
 * user launched. Staggered: several Session processes opening their databases at once is a
 * cold-start spike.
 */
export function startBackgroundAccounts() {
  let others: Array<{ id: string }> = [];
  try {
    const current = getSelectedAccount().id;
    others = listAccounts().filter(a => a.id !== current && a.runInBackground);
  } catch (e) {
    console.error('accounts: could not list background accounts', e?.message);
  }
  others.forEach((account, index) => {
    setTimeout(
      () => {
        void launchAccount(account.id, true);
      },
      1500 * (index + 1)
    );
  });
}

/**
 * The updater's relaunch cannot be given arguments: Squirrel.Mac, the NSIS installer and the
 * AppImage updater all start the app with their own command line. It therefore comes back as
 * whichever account the registry's `activeId` names, so point that at this account as the update
 * starts. Another account changing `activeId` in the moment between this and the relaunch would
 * still win; that window is the residual risk.
 */
export function pinAccountForUpdateRelaunch() {
  try {
    autoUpdater.on('before-quit-for-update', () => {
      markAccountUsed(getSelectedAccount().id);
    });
  } catch (e) {
    console.error('accounts: could not watch for an update relaunch', e?.message);
  }
}

/**
 * The account IPC. Every handler answers with a result the switcher can show; none of them throws
 * across IPC, where a rejection would only surface as an unhandled promise in the renderer.
 */
export function registerAccountIpc(ipc: IpcMain, showThisWindow: () => void) {
  ipc.handle('get-accounts', () => {
    const currentId = getSelectedAccount().id;
    try {
      return {
        currentId,
        accounts: listAccounts().map(a => ({
          id: a.id,
          label: a.label,
          displayName: a.displayName,
          sessionId: a.sessionId,
          isDefault: a.isDefault,
          runInBackground: a.runInBackground,
          lastUsedAt: a.lastUsedAt,
          isCurrent: a.id === currentId,
        })),
      };
    } catch (e) {
      return { currentId, accounts: [], error: e?.message || String(e) };
    }
  });

  ipc.handle('switch-account', async (_event, accountId: string): Promise<LaunchResult> => {
    if (accountId === getSelectedAccount().id) {
      showThisWindow();
      return { ok: true };
    }
    return launchAccount(accountId, false);
  });

  ipc.handle('add-account', async (_event, label: string | undefined) => {
    let account;
    try {
      account = addAccount(label);
    } catch (e) {
      return { ok: false, error: e?.message || String(e) };
    }
    const launched = await launchAccount(account.id, false);
    return {
      ok: true,
      id: account.id,
      label: account.label,
      launchError: launched.ok ? undefined : launched.error,
    };
  });

  ipc.handle('rename-account', (_event, accountId: string, label: string) =>
    renameAccount(accountId, label)
  );

  ipc.handle('set-account-run-in-background', (_event, accountId: string, value: boolean) =>
    setAccountRunInBackground(accountId, value)
  );

  /**
   * Forgetting an account removes it from the switcher and leaves its data on disk. The directory
   * is returned so the caller can tell the user where their messages still are.
   */
  ipc.handle('forget-account', (_event, accountId: string) => {
    if (accountId === getSelectedAccount().id) {
      return {
        removed: false,
        dataDir: null,
        reason: 'You cannot remove the account you are using.',
      };
    }
    return forgetAccount(accountId);
  });

  /**
   * The renderer is the only thing that knows who is logged in, so it tells us once it does. This
   * is what puts a real name and Account ID next to each entry in the switcher.
   */
  ipc.handle('update-account-meta', (_event, meta: { sessionId?: string; displayName?: string }) =>
    updateAccountMeta(getSelectedAccount().id, meta)
  );

  ipc.handle('get-account-data-dir', (_event, accountId: string) => {
    try {
      const account = listAccounts().find(a => a.id === accountId);
      return account ? userDataPathFor(account) : null;
    } catch (e) {
      return null;
    }
  });
}
