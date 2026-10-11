// The runner must drive an app that has neither a /healthz endpoint nor a SQLite database (live run 1 had to write a
// custom driver because it assumed both). "healthz": null means readiness is a "ready" regex in the app's output, else a
// TCP connect; no "db" in live-verify.json means no database, no {{db}} and no db snapshot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const RUNNER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'runner.mjs');

const SERVER = `
import http from 'node:http';
const srv = http.createServer((req, res) => { res.statusCode = req.url === '/healthz' ? 404 : 200; res.end('hi'); });
srv.listen(Number(process.env.PORT), '127.0.0.1', () => { if (process.env.SAY_READY) console.log('app is listening'); });
`;
const SCENARIO = `
export const meta = { name: 'drives a plain http app', journey: 'J1.plain' };
export default async function (ctx) {
  const res = await fetch(ctx.app.url + '/anything');
  ctx.expect('the app answers', res.status, 200);
  ctx.ok('there is no database', ctx.db === undefined);
}
`;

function makeApp(manifest, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lv-optional-'));
  fs.mkdirSync(path.join(dir, 'scenarios'));
  fs.writeFileSync(path.join(dir, 'server.mjs'), SERVER);
  fs.writeFileSync(path.join(dir, 'scenarios', '01-plain.mjs'), SCENARIO);
  fs.writeFileSync(path.join(dir, 'live-verify.json'), JSON.stringify({ start: ['node', 'server.mjs'], env: { PORT: '{{port}}', ...env }, ...manifest }));
  return dir;
}

function run(app) {
  const r = spawnSync(process.execPath, ['--no-warnings', RUNNER, '--app', app, '--instances', '1'], { cwd: app, encoding: 'utf8', timeout: 60000 });
  const live = path.join(app, '.scratch', 'live');
  const runs = fs.existsSync(live) ? fs.readdirSync(live) : [];
  return { ...r, evidence: runs.length ? path.join(live, runs[0]) : '' };
}

test('healthz null with a "ready" regex: no HTTP health path, no database', () => {
  const app = makeApp({ healthz: null, ready: 'is listening' }, { SAY_READY: '1' });
  const r = run(app);
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /1\/1 scenarios passed/);
  assert.equal(fs.existsSync(path.join(r.evidence, 'db.sqlite')), false);
});

test('healthz null without "ready": readiness is a TCP connect', () => {
  const app = makeApp({ healthz: null });
  const r = run(app);
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /1\/1 scenarios passed/);
});

test('a manifest with "db": false and no {{db}} in env boots with no database', () => {
  const app = makeApp({ healthz: null, db: false });
  const r = run(app);
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
});

test('a ready regex that never matches fails with the reason, not a hang', () => {
  const app = makeApp({ healthz: null, ready: 'never printed' });
  const r = run(app);
  assert.notEqual(r.status, 0);
  assert.match(`${r.stdout}${r.stderr}`, /not healthy after .* output has not matched/);
});
