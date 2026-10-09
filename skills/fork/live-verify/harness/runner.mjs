#!/usr/bin/env node
// Live verification runner.
//   node harness/runner.mjs --app <app-dir> [--instances 2] [--llm stub|claude] [--only name]
// Boots the stand-ins, boots N app instances against them with a shared SQLite
// file, waits for each /healthz doctor, runs <app-dir>/scenarios/*.mjs in order,
// tears down only what it started, keeps the evidence, and exits non-zero on failure.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { parseArgs, isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { startSlack } from './standins/slack.mjs';
import { startGmail } from './standins/gmail.mjs';
import { startLlm } from './standins/llm.mjs';
import { currentSeq } from './lib/recorder.mjs';
import { writeReport } from './lib/report.mjs';

const { values: args } = parseArgs({
  options: {
    app: { type: 'string' },
    instances: { type: 'string', default: '2' },
    llm: { type: 'string', default: 'stub' },
    only: { type: 'string' },
    timeout: { type: 'string' },
  },
});
if (!args.app) { console.error('usage: runner.mjs --app <app-dir> [--instances 2] [--llm stub|claude] [--only name]'); process.exit(2); }
if (!['stub', 'claude'].includes(args.llm)) { console.error('--llm must be stub or claude'); process.exit(2); }

const appDir = path.resolve(args.app);
const manifest = JSON.parse(fs.readFileSync(path.join(appDir, 'live-verify.json'), 'utf8'));
const instanceCount = Math.max(1, Number(args.instances));
const timeScale = args.llm === 'claude' ? 6 : 1;
const scenarioTimeoutMs = Number(args.timeout ?? 60000 * timeScale);
const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}`;
const outDir = path.resolve('.scratch/live', runId);
fs.mkdirSync(outDir, { recursive: true });

class AssertionFailed extends Error {}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

// Replaces {{a.b}} in manifest env values from the run context.
function fill(template, vars) {
  return template.replace(/\{\{([\w.]+)\}\}/g, (_, key) => {
    const v = key.split('.').reduce((o, k) => o?.[k], vars);
    if (v == null) throw new Error(`live-verify.json references unknown {{${key}}}`);
    return String(v);
  });
}

const children = new Set();

// One app instance. kill() is SIGKILL on our own child pid only (a crash, not a
// graceful stop); restart() relaunches on a new port with the same id and log file.
async function startInstance(i, vars) {
  const inst = { id: `app-${i}`, logFile: path.join(outDir, `app-${i}.log`), alive: false };
  inst.launch = async () => {
    const port = await freePort();
    const env = { ...process.env };
    for (const [k, v] of Object.entries(manifest.env ?? {})) env[k] = fill(v, { ...vars, port, instance: inst.id });
    const log = fs.openSync(inst.logFile, 'a');
    const [cmd, ...cmdArgs] = manifest.start;
    const child = spawn(cmd, cmdArgs, { cwd: appDir, env, stdio: ['ignore', log, log] });
    fs.closeSync(log);
    children.add(child);
    Object.assign(inst, { url: `http://127.0.0.1:${port}`, child, alive: true });
    child.once('exit', () => { if (inst.child === child) inst.alive = false; children.delete(child); });
    await waitHealthy(inst);
  };
  inst.kill = async () => {
    if (!inst.alive) return;
    const exited = new Promise((r) => inst.child.once('exit', r));
    inst.child.kill('SIGKILL');
    await exited;
  };
  inst.restart = async () => { await inst.kill(); await inst.launch(); };
  await inst.launch();
  return inst;
}

// The doctor: the app's /healthz must answer 200 before anything drives it.
async function waitHealthy(inst, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let last = 'no answer';
  while (Date.now() < deadline) {
    if (!inst.alive) throw new Error(`${inst.id} exited with ${inst.child.exitCode} before /healthz; see ${inst.logFile}`);
    try {
      const res = await fetch(`${inst.url}${manifest.healthz ?? '/healthz'}`, { signal: AbortSignal.timeout(1000) });
      last = `${res.status} ${await res.text()}`;
      if (res.ok) return;
    } catch (err) { last = err.message; }
    await sleep(50);
  }
  throw new Error(`${inst.id} not healthy after ${timeoutMs} ms: ${last}`);
}

function readLogs(instances) {
  return instances.flatMap((inst) => {
    if (!fs.existsSync(inst.logFile)) return [];
    return fs.readFileSync(inst.logFile, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
      try { return [{ instance: inst.id, ...JSON.parse(line) }]; } catch { return []; }
    });
  });
}

function makeContext({ scenario, standins, instances, db, secrets }) {
  const record = scenario.assertions;
  const pass = (name, evidence) => record.push({ name, pass: true, evidence });
  const fail = (name, evidence) => { record.push({ name, pass: false, evidence }); throw new AssertionFailed(name); };
  return {
    ...standins,
    apps: instances,
    get app() { return instances[0]; },
    // Rows come back as plain objects so deep-equal assertions compare values only.
    db: {
      get: (sql, ...p) => { const r = db.prepare(sql).get(...p); return r ? { ...r } : r; },
      all: (sql, ...p) => db.prepare(sql).all(...p).map((r) => ({ ...r })),
    },
    secrets,
    llmMode: args.llm,
    timeScale,
    uid: (prefix = 'x') => `${prefix}${crypto.randomBytes(4).toString('hex').toUpperCase()}`,
    step: (name) => scenario.steps.push({ name, at: Date.now() - scenario.started }),
    ok: (name, cond, evidence) => (cond ? pass(name, evidence) : fail(name, evidence)),
    expect: (name, actual, expected) => (isDeepStrictEqual(actual, expected)
      ? pass(name, { actual }) : fail(name, { actual, expected })),
    // Polls a predicate (sync or async) until it returns a truthy value; no fixed sleeps.
    async waitFor(predicate, timeoutMs = 10000, label = 'condition') {
      const deadline = Date.now() + timeoutMs * timeScale;
      for (;;) {
        const v = await predicate();
        if (v) return v;
        if (Date.now() > deadline) fail(`waitFor: ${label}`, { timeoutMs: timeoutMs * timeScale });
        await sleep(25);
      }
    },
    logs: (filter = () => true) => readLogs(instances).filter(filter),
    instanceOf: (call) => instances.find((i) => call?.client?.includes(i.id)),
  };
}

async function main() {
  const t0 = Date.now();
  const secrets = {
    slackSigning: crypto.randomBytes(16).toString('hex'),
    pushToken: crypto.randomBytes(16).toString('hex'),
    adminToken: crypto.randomBytes(16).toString('hex'),
    llmKey: `sk-live-verify-${crypto.randomBytes(8).toString('hex')}`,
    encKey: crypto.randomBytes(32).toString('hex'),
  };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'live-verify-'));
  const dbPath = path.join(tmp, 'app.sqlite');
  const slack = await startSlack({ signingSecret: secrets.slackSigning });
  const gmail = await startGmail({ pushToken: secrets.pushToken });
  const llm = await startLlm({ apiKey: secrets.llmKey, defaultReply: () => 'stub reply' });
  const standins = { slack, gmail, llm };
  const vars = {
    slack: { url: slack.url }, gmail: { url: gmail.url }, llm: { url: llm.url, provider: args.llm === 'claude' ? 'claude-cli' : 'anthropic' },
    db: dbPath, secrets,
  };
  const instances = [];
  const run = { runId, app: path.relative(process.cwd(), appDir), instances: instanceCount, llm: args.llm, startedAt: new Date(t0).toISOString(), scenarios: [] };
  let db;
  const teardown = async () => {
    for (const child of children) child.kill('SIGTERM');
    const deadline = Date.now() + 3000;
    while (children.size && Date.now() < deadline) await sleep(25);
    for (const child of children) child.kill('SIGKILL');
    db?.close();
    await Promise.all(Object.values(standins).map((s) => s.close()));
    const calls = [...slack.calls(), ...gmail.calls(), ...llm.calls()].sort((a, b) => a.seq - b.seq);
    fs.writeFileSync(path.join(outDir, 'calls.json'), JSON.stringify(calls, null, 2));
    if (fs.existsSync(dbPath)) {
      const snap = new DatabaseSync(dbPath);
      snap.exec(`VACUUM INTO '${path.join(outDir, 'db.sqlite').replace(/'/g, "''")}'`);
      snap.close();
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  };
  process.once('SIGINT', async () => { await teardown(); process.exit(130); });

  try {
    for (let i = 0; i < instanceCount; i++) instances.push(await startInstance(i, vars));
    db = new DatabaseSync(dbPath, { readOnly: true });
    const scenarioDir = path.join(appDir, 'scenarios');
    const setupFile = path.join(scenarioDir, '_setup.mjs');
    const setup = fs.existsSync(setupFile) ? await import(pathToFileURL(setupFile)) : {};
    const files = fs.readdirSync(scenarioDir).filter((f) => f.endsWith('.mjs') && !f.startsWith('_')).sort();
    console.log(`live-verify ${runId}: ${files.length} scenario files, ${instanceCount} instance(s), llm=${args.llm}`);
    for (const file of files) {
      const mod = await import(pathToFileURL(path.join(scenarioDir, file)));
      const meta = mod.meta ?? { name: file };
      if (args.only && !meta.name.includes(args.only) && !file.includes(args.only)) continue;
      const scenario = { name: meta.name, file, journey: meta.journey, concerns: meta.concerns, steps: [], assertions: [], started: Date.now() };
      for (const s of Object.values(standins)) s.reset();
      for (const inst of instances) if (!inst.alive) await inst.restart();
      const seq0 = currentSeq();
      const ackStart = { slack: slack.acks.length, gmail: gmail.acks.length };
      const ctx = makeContext({ scenario, standins, instances, db, secrets });
      try {
        await setup.beforeEach?.(ctx);
        let timer;
        await Promise.race([
          mod.default(ctx),
          new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`scenario timed out after ${scenarioTimeoutMs} ms`)), scenarioTimeoutMs); }),
        ]).finally(() => clearTimeout(timer));
        // Platform deadline invariant checked on every scenario (LAT-02, UJ-05).
        const late = slack.acks.slice(ackStart.slack).filter((a) => a.late);
        ctx.ok('every Slack ack within 3000 ms', late.length === 0, { late });
        scenario.result = 'pass';
      } catch (err) {
        scenario.result = 'fail';
        scenario.error = err instanceof AssertionFailed ? `assertion failed: ${err.message}` : String(err?.stack ?? err);
      }
      scenario.durationMs = Date.now() - scenario.started;
      scenario.acks = [...slack.acks.slice(ackStart.slack), ...gmail.acks.slice(ackStart.gmail)].map(({ kind, status, ms, retryNum }) => ({ kind, status, ms, retryNum }));
      scenario.callSeqRange = [seq0 + 1, currentSeq()];
      delete scenario.started;
      run.scenarios.push(scenario);
      console.log(`${scenario.result === 'pass' ? 'PASS' : 'FAIL'}  ${scenario.name}  (${scenario.durationMs} ms)`);
    }
  } catch (err) {
    run.error = String(err?.stack ?? err);
    console.error(`runner error: ${err.message}`);
  } finally {
    await teardown();
  }
  run.durationMs = Date.now() - t0;
  const passed = run.scenarios.filter((s) => s.result === 'pass').length;
  run.totals = { scenarios: run.scenarios.length, passed, failed: run.scenarios.length - passed + (run.error ? 1 : 0), assertions: run.scenarios.reduce((n, s) => n + s.assertions.length, 0) };
  writeReport(outDir, run);
  console.log(`${passed}/${run.scenarios.length} scenarios passed, ${run.totals.assertions} assertions, ${run.durationMs} ms. Evidence: ${path.relative(process.cwd(), outDir)}`);
  process.exit(run.totals.failed === 0 && run.scenarios.length > 0 ? 0 : 1);
}

main();
