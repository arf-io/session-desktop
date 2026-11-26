/* eslint-disable no-console */
/**
 * Not a spec (no `_test` suffix): a helper the registry tests fork, so that several real processes
 * write the one shared registry file at the same time, exactly as several account processes do.
 *
 * argv: <appData> <mode> [count]
 *   add    wait for 'go' from the parent, add <count> accounts, send back the ids it was given
 *   read   send back what readRegistry() returns
 *   hold   take the registry lock, report it, then hang until killed
 */
import fs from 'fs';

import * as profiles from '../../../../node/config/profiles';

const [appData, mode, countArg] = process.argv.slice(2);

function send(message: Record<string, unknown>) {
  if (process.send) {
    process.send(message);
  }
}

profiles.resetAccountsModuleForTesting(appData);

if (mode === 'add') {
  const count = Number(countArg);
  process.on('message', (msg: any) => {
    if (msg !== 'go') {
      return;
    }
    const ids: Array<string> = [];
    const errors: Array<string> = [];
    for (let i = 0; i < count; i++) {
      try {
        ids.push(profiles.addAccount().id);
      } catch (e) {
        errors.push(String(e?.message || e));
      }
    }
    send({ ids, errors });
    process.exit(0);
  });
  send({ ready: true });
} else if (mode === 'read') {
  send({ registry: profiles.readRegistry() });
  process.exit(0);
} else if (mode === 'hold') {
  profiles.acquireRegistryLockForTesting();
  // as if killed between writing its temporary file and renaming it into place
  fs.writeFileSync(`${appData}/Session-accounts.json.${process.pid}-0badc0de.tmp`, '{ half');
  send({ locked: true });
  setInterval(() => undefined, 1000);
} else {
  console.error(`unknown mode ${mode}`);
  process.exit(2);
}
