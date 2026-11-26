/* eslint-disable no-unused-expressions */
import { ChildProcess, fork } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { expect } from 'chai';

/**
 * Every account is its own process, and all of them read-modify-write one registry file. These
 * tests run real, separate Node processes against a scratch appData directory, because a
 * single-process test cannot show a cross-process lost update or a lock left behind by a writer
 * that was killed.
 */
describe('multi-account registry across processes', function registryAcrossProcesses() {
  this.timeout(60000);

  const child = path.join(__dirname, 'registry_child.js');
  let appData: string;

  function childEnv() {
    const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'production' };
    delete env.NODE_APP_INSTANCE;
    delete env.SESSION_PROFILE;
    return env;
  }

  function start(mode: string, extra: Array<string> = []): ChildProcess {
    return fork(child, [appData, mode, ...extra], { env: childEnv(), stdio: 'pipe' });
  }

  function nextMessage(proc: ChildProcess): Promise<any> {
    return new Promise((resolve, reject) => {
      proc.once('message', resolve);
      proc.once('exit', code => reject(new Error(`child exited (${code}) before replying`)));
    });
  }

  function registryPath() {
    return path.join(appData, 'Session-accounts.json');
  }

  beforeEach(() => {
    appData = fs.mkdtempSync(path.join(os.tmpdir(), 'session-accounts-proc-'));
  });

  afterEach(() => {
    fs.rmSync(appData, { recursive: true, force: true });
  });

  it('keeps every account added by several processes writing at once', async () => {
    const writers = 4;
    const perWriter = 25;

    // create the registry first, so the race is on adding and not on first-run creation
    const first = start('read');
    await nextMessage(first);

    const procs = Array.from({ length: writers }, () => start('add', [String(perWriter)]));
    // barrier: every child is loaded and waiting before any of them starts writing
    const ready = procs.map(nextMessage);
    await Promise.all(ready);
    const results = procs.map(nextMessage);
    procs.forEach(p => p.send('go'));
    const replies = await Promise.all(results);

    const returned = replies.flatMap(r => r.ids as Array<string>);
    const errors = replies.flatMap(r => r.errors as Array<string>);
    expect(errors, 'no writer should fail').to.deep.equal([]);
    expect(returned.length).to.equal(writers * perWriter);

    const onDisk = JSON.parse(fs.readFileSync(registryPath(), 'utf8'));
    const persisted = new Set(onDisk.accounts.map((a: { id: string }) => a.id));
    const lost = returned.filter(id => !persisted.has(id));
    expect(
      lost,
      `${lost.length} of ${returned.length} returned ids were never persisted`
    ).to.deep.equal([]);
    expect(onDisk.accounts.length).to.equal(writers * perWriter + 1);

    const leftovers = fs
      .readdirSync(appData)
      .filter(f => f.includes('.tmp') || f.includes('.lock'));
    expect(leftovers, 'no tmp files or lock left behind').to.deep.equal([]);
  });

  it('recovers from a writer killed while holding the registry lock', async () => {
    const first = start('read');
    await nextMessage(first);

    const holder = start('hold');
    expect(await nextMessage(holder)).to.deep.equal({ locked: true });
    expect(fs.existsSync(`${registryPath()}.lock`)).to.be.true;
    const exited = new Promise(resolve => {
      holder.once('exit', resolve);
    });
    holder.kill('SIGKILL');
    await exited;
    // the dead writer's lock and half-written file are still there
    expect(fs.existsSync(`${registryPath()}.lock`)).to.be.true;
    expect(fs.readdirSync(appData).filter(f => f.endsWith('.tmp'))).to.have.length(1);

    const writer = start('add', ['1']);
    await nextMessage(writer);
    const reply = nextMessage(writer);
    writer.send('go');
    const { ids, errors } = await reply;
    expect(errors).to.deep.equal([]);
    expect(ids).to.have.length(1);

    const onDisk = JSON.parse(fs.readFileSync(registryPath(), 'utf8'));
    expect(onDisk.accounts.map((a: { id: string }) => a.id)).to.include(ids[0]);
    expect(
      fs.readdirSync(appData).filter(f => f.includes('.lock') || f.includes('.tmp'))
    ).to.deep.equal([]);
  });

  it('a fresh process does not write a default over a registry it cannot parse', async () => {
    // an earlier process added accounts and their data directories exist
    const seed = start('add', ['2']);
    await nextMessage(seed);
    const seeded = nextMessage(seed);
    seed.send('go');
    const added: { ids: Array<string> } = await seeded;
    added.ids.forEach(id => fs.mkdirSync(path.join(appData, `Session-acct-${id}`)));

    // the file is then torn
    fs.writeFileSync(registryPath(), '{ "version": 1, "activeId": "def');

    const fresh = start('read');
    const { registry } = await nextMessage(fresh);
    const ids = registry.accounts.map((a: { id: string }) => a.id);

    expect(ids[0]).to.equal('default');
    expect(ids).to.include.members(added.ids);
    const onDisk = JSON.parse(fs.readFileSync(registryPath(), 'utf8'));
    expect(onDisk.accounts.map((a: { id: string }) => a.id)).to.include.members(added.ids);

    const corrupt = fs
      .readdirSync(appData)
      .filter(f => f.startsWith('Session-accounts.json.corrupt-'));
    expect(corrupt.length).to.equal(1);
    expect(fs.readFileSync(path.join(appData, corrupt[0]), 'utf8')).to.equal(
      '{ "version": 1, "activeId": "def'
    );
  });
});
