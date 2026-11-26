#!/usr/bin/env node
/* eslint-disable no-console */
// Session, but Better: merge the x64 and arm64 builds of Session.app into one universal app.
//
//   node .github/sbb/make-universal-mac.cjs <x64 Session.app> <arm64 Session.app> <out Session.app>
//
// Both inputs are modified in place (signatures stripped, native packages unioned), so pass
// scratch copies. electron-builder cannot build a universal Session in one go: its native
// modules are compiled per architecture, so we build each architecture natively and merge the
// results with @electron/universal, after evening out the few places where the two builds differ:
//
// 1. Code signatures. Each input is signed on its own; the merge compares files byte for byte,
//    so every signature is removed first and the universal app is signed once at the end.
// 2. The libsession worker loads a .node file whose name is a content hash, so the name differs
//    per architecture. The arm64 app.asar is repacked to use the x64 name; the two binaries then
//    sit at the same path and merge into one universal .node.
// 3. sharp and sqlcipher ship each architecture as a separate package directory and choose one
//    at runtime by process.arch. Each app gets the union of both, kept as single-arch files.
// 4. Info.plist build numbers must match; they come from the same CI run, but are aligned anyway.
//
// Signing is ad hoc unless MAC_SIGN_IDENTITY names a Developer ID certificate in the keychain.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { createRequire } = require('module');

// pnpm does not hoist electron-builder's dependencies; resolve them through it so we use the
// exact versions in the lockfile
const repoRequire = createRequire(path.join(process.cwd(), 'package.json'));
const electronBuilderRequire = createRequire(repoRequire.resolve('electron-builder/package.json'));
const builderRequire = createRequire(
  electronBuilderRequire.resolve('app-builder-lib/package.json')
);
const { makeUniversalApp } = builderRequire('@electron/universal');
const universalRequire = createRequire(builderRequire.resolve('@electron/universal/package.json'));
const asar = universalRequire('@electron/asar');

const LIBSESSION_WORKER_DIR = 'ts/webworker/workers/node/libsession';
const WORKER_JS = 'libsession.worker.compiled.js';
// package directories that exist once per architecture
const PER_ARCH_DIRS = [
  '@img/sharp-darwin-ARCH',
  '@img/sharp-libvips-darwin-ARCH',
  '@signalapp/sqlcipher/prebuilds/darwin-ARCH',
];

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      continue;
    }
    if (entry.isDirectory()) {
      walk(p, out);
    } else {
      out.push(p);
    }
  }
  return out;
}

function isMachO(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(4);
    if (fs.readSync(fd, buf, 0, 4, 0) < 4) {
      return false;
    }
    const magic = buf.readUInt32BE(0);
    // thin 32/64-bit in either byte order, and fat binaries
    return [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca].includes(magic);
  } finally {
    fs.closeSync(fd);
  }
}

function stripSignatures(app) {
  for (const dir of findDirs(app, '_CodeSignature')) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  let n = 0;
  for (const file of walk(app)) {
    if (isMachO(file)) {
      try {
        run('codesign', ['--remove-signature', file]);
        n++;
      } catch {
        // unsigned already
      }
    }
  }
  console.log(`stripped signatures from ${n} binaries in ${app}`);
}

function findDirs(root, name, out = []) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      const p = path.join(root, entry.name);
      if (entry.name === name) {
        out.push(p);
      } else {
        findDirs(p, name, out);
      }
    }
  }
  return out;
}

function asarPath(app) {
  return path.join(app, 'Contents/Resources/app.asar');
}

function listFiles(archive) {
  return asar
    .listPackage(archive, { isPack: false })
    .map(f => f.replace(/^[\\/]/, ''))
    .filter(f => !('files' in asar.statFile(archive, f)));
}

function unpackedFiles(archive) {
  return listFiles(archive).filter(f => asar.statFile(archive, f).unpacked);
}

function workerNodeName(archive) {
  const names = listFiles(archive).filter(
    f => path.dirname(f) === LIBSESSION_WORKER_DIR && f.endsWith('.node')
  );
  if (names.length !== 1) {
    throw new Error(`expected one libsession .node in ${archive}, found ${names.length}`);
  }
  return path.basename(names[0], '.node');
}

/** Repack the arm64 app.asar so its libsession worker .node has the x64 build's name. */
async function alignWorkerName(x64App, arm64App) {
  const archive = asarPath(arm64App);
  const from = workerNodeName(archive);
  const to = workerNodeName(asarPath(x64App));
  if (from === to) {
    console.log('libsession worker names already match');
    return;
  }
  const unpacked = unpackedFiles(archive);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbb-arm64-asar-'));
  try {
    asar.extractAll(archive, dir);
    const wdir = path.join(dir, LIBSESSION_WORKER_DIR);
    fs.renameSync(path.join(wdir, `${from}.node`), path.join(wdir, `${to}.node`));
    const js = path.join(wdir, WORKER_JS);
    const src = fs.readFileSync(js, 'utf8');
    if (src.split(from).length !== 2) {
      throw new Error(`expected exactly one reference to ${from} in ${WORKER_JS}`);
    }
    fs.writeFileSync(js, src.replace(from, to));

    const renamed = unpacked.map(f => f.replace(`${from}.node`, `${to}.node`));
    const out = `${archive}.new`;
    // asar matches unpack patterns against absolute paths, hence the leading **/
    await asar.createPackageWithOptions(dir, out, {
      unpack: `{${renamed.map(f => `**/${f}`).join(',')}}`,
    });
    const after = unpackedFiles(out);
    if (after.length !== unpacked.length || !fs.existsSync(`${out}.unpacked`)) {
      throw new Error(`repack changed the unpacked set: ${unpacked.length} -> ${after.length}`);
    }
    fs.rmSync(archive);
    fs.rmSync(`${archive}.unpacked`, { recursive: true, force: true });
    fs.renameSync(out, archive);
    fs.renameSync(`${out}.unpacked`, `${archive}.unpacked`);
    // @electron/asar caches each archive's header by path, and @electron/universal shares this
    // module instance: without this it would merge using the arm64 header from before the repack
    asar.uncacheAll();
    console.log(`renamed arm64 libsession worker ${from}.node -> ${to}.node`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Give both apps every architecture's copy of the per-architecture packages. */
function unionPerArchPackages(x64App, arm64App) {
  const modules = app => path.join(app, 'Contents/Resources/app.asar.unpacked/node_modules');
  for (const [from, to, arch] of [
    [x64App, arm64App, 'x64'],
    [arm64App, x64App, 'arm64'],
  ]) {
    for (const template of PER_ARCH_DIRS) {
      const rel = template.replace('ARCH', arch);
      const src = path.join(modules(from), rel);
      const dest = path.join(modules(to), rel);
      if (!fs.existsSync(src)) {
        throw new Error(`missing ${rel} in the ${arch} build`);
      }
      if (!fs.existsSync(dest)) {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.cpSync(src, dest, { recursive: true, verbatimSymlinks: true });
      }
    }
  }
}

function alignBundleVersions(x64App, arm64App) {
  const plists = findFiles(x64App, 'Info.plist');
  for (const plist of plists) {
    const rel = path.relative(x64App, plist);
    const other = path.join(arm64App, rel);
    if (!fs.existsSync(other)) {
      continue;
    }
    try {
      const v = run('/usr/libexec/PlistBuddy', ['-c', 'Print CFBundleVersion', plist]).trim();
      run('/usr/libexec/PlistBuddy', ['-c', `Set :CFBundleVersion ${v}`, other]);
    } catch {
      // no CFBundleVersion in this plist
    }
  }
}

function findFiles(root, name, out = []) {
  for (const f of walk(root)) {
    if (path.basename(f) === name) {
      out.push(f);
    }
  }
  return out;
}

/**
 * Sign from the inside out: `codesign --deep` misses nested binaries such as libffmpeg.dylib, and
 * arm64 macOS kills any process whose code is not validly signed.
 */
function sign(app, entitlements) {
  const identity = process.env.MAC_SIGN_IDENTITY || '-';
  const base = ['--force', '--sign', identity, '--options', 'runtime'];
  if (identity !== '-') {
    base.push('--timestamp');
  }
  const contents = path.join(app, 'Contents');
  const nested = walk(contents).filter(
    f => isMachO(f) && f !== path.join(contents, 'MacOS', path.basename(app, '.app'))
  );
  // deepest first, so containers are signed after what they contain
  nested.sort((a, b) => b.split(path.sep).length - a.split(path.sep).length);
  for (const f of nested) {
    run('codesign', [...base, f]);
  }
  const frameworks = path.join(contents, 'Frameworks');
  const bundles = fs
    .readdirSync(frameworks)
    .filter(n => n.endsWith('.framework') || n.endsWith('.app'));
  for (const n of bundles.filter(b => b.endsWith('.framework'))) {
    run('codesign', [...base, path.join(frameworks, n)]);
  }
  for (const n of bundles.filter(b => b.endsWith('.app'))) {
    run('codesign', [...base, '--entitlements', entitlements, path.join(frameworks, n)]);
  }
  run('codesign', [...base, '--entitlements', entitlements, app]);
  run('codesign', ['--verify', '--deep', '--strict', app]);
  console.log(
    `signed ${nested.length} nested binaries and ${app} (${identity === '-' ? 'ad hoc' : identity})`
  );
}

async function main() {
  const [x64App, arm64App, outApp] = process.argv.slice(2).map(p => p && path.resolve(p));
  if (!x64App || !arm64App || !outApp) {
    console.error(
      'usage: make-universal-mac.cjs <x64 Session.app> <arm64 Session.app> <out Session.app>'
    );
    process.exit(2);
  }
  const entitlements = path.resolve('build/entitlements.mac.plist');

  stripSignatures(x64App);
  stripSignatures(arm64App);
  // repacking rewrites app.asar.unpacked, so it must come before the union
  await alignWorkerName(x64App, arm64App);
  unionPerArchPackages(x64App, arm64App);
  alignBundleVersions(x64App, arm64App);

  fs.rmSync(outApp, { recursive: true, force: true });
  await makeUniversalApp({
    x64AppPath: x64App,
    arm64AppPath: arm64App,
    outAppPath: outApp,
    mergeASARs: true,
    singleArchFiles:
      '{node_modules/@img/sharp-*darwin-*/**,node_modules/@img/sharp-*darwin-*,node_modules/@signalapp/sqlcipher/prebuilds/darwin-*/**,node_modules/@signalapp/sqlcipher/prebuilds/darwin-*}',
    x64ArchFiles:
      '{**/node_modules/@img/sharp-*darwin-*/**,**/node_modules/@signalapp/sqlcipher/prebuilds/darwin-*/**}',
    force: true,
  });
  console.log(`universal app written to ${outApp}`);
  sign(outApp, entitlements);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
