/* eslint-disable no-console */
// Session, but Better: load every native module of a packaged Session.app in the current
// architecture. Run it with the app's own binary, once per architecture:
//
//   ELECTRON_RUN_AS_NODE=1 arch -x86_64 Session.app/Contents/MacOS/Session load-native-modules.cjs Session.app/Contents/Resources/app.asar
//
// Exits non-zero if any module fails to load.
'use strict';

const fs = require('fs');
const path = require('path');

const asarRoot = process.argv[2];
const workerDir = path.join(asarRoot, 'ts/webworker/workers/node/libsession');
const workerNode = fs.readdirSync(workerDir).find(f => f.endsWith('.node'));

const modules = {
  libsession: path.join(asarRoot, 'node_modules/libsession_util_nodejs'),
  'libsession worker': path.join(workerDir, workerNode || 'missing.node'),
  sqlcipher: path.join(asarRoot, 'node_modules/@signalapp/sqlcipher'),
  sharp: path.join(asarRoot, 'node_modules/sharp'),
};

let failed = 0;
for (const [name, target] of Object.entries(modules)) {
  try {
    require(target);
    console.log(`${process.arch} ${name}: ok`);
  } catch (e) {
    failed++;
    console.log(`${process.arch} ${name}: FAILED ${String(e.message).split('\n')[0]}`);
  }
}
process.exit(failed ? 1 : 0);
