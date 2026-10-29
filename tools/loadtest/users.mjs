// Load-test user generator: 300 company portal users against the cloud API over real HTTP
// (docs/testing/load-test-spec.md, "Users"). Started by run.mjs with an IPC channel:
// argv = <plan.json>. Messages in: {type:'start', measureStart, measureEnd}. Out: {type:'results'}.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { between, pick, sleep } from './lib.mjs';

const plan = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const BASE = plan.cloudUrl;
const TIMEOUT_MS = 10_000;

let measureStart = Infinity;
let measureEnd = Infinity;
let stopping = false;

// --- recording -----------------------------------------------------------------------------------
const latencies = new Map(); // "METHOD template" -> number[] (measured window only)
const all = [];
const counts = { measured: 0, warmup: 0, unexpected: 0, expectedDenials: 0 };
const unexpected = []; // first 200, with details
const unexpectedByKind = {};
const violations = { isolation: [], invalidGrant: [] };
const sessions = { requested: 0, active: 0, neverActive: 0, finished: 0, timeToActiveMs: [], commands: 0, diagnostics: 0 };
const logins = { ok: 0, failed: 0 };
const fleetSamples = [];

const inWindow = (t) => t >= measureStart && t < measureEnd;

/**
 * One API request. `expect` is the set of statuses that are a correct answer for this request;
 * anything else (incl. timeouts and connection errors) is an unexpected error.
 */
async function call(user, method, path, template, { body, expect = [200], kind = 'normal' } = {}) {
  const t0 = Date.now();
  const start = performance.now();
  let status = 0;
  let json = null;
  let error = null;
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        'x-forwarded-for': user.ip,
        ...(user.cookie ? { cookie: user.cookie } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    status = res.status;
    const text = await res.text();
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (res.headers.getSetCookie().length) user.setCookie = res.headers.getSetCookie();
  } catch (err) {
    error = err.name === 'TimeoutError' ? 'timeout' : `${err.name}: ${err.cause?.code ?? err.message}`;
  }
  const ms = performance.now() - start;
  const ok = !error && expect.includes(status);
  const key = `${method} ${template}`;
  if (inWindow(t0)) {
    counts.measured++;
    all.push(ms);
    let arr = latencies.get(key);
    if (!arr) latencies.set(key, (arr = []));
    arr.push(ms);
    if (!ok) {
      counts.unexpected++;
      const k = `${key} -> ${error ?? status}`;
      unexpectedByKind[k] = (unexpectedByKind[k] ?? 0) + 1;
      if (unexpected.length < 200) unexpected.push({ at: t0, user: user.email, key, path, status, error, body: json });
    } else if (status >= 400) counts.expectedDenials++;
  } else if (t0 < measureStart) counts.warmup++;
  // Security outcomes count at any time, warm-up included.
  if (kind === 'isolation' && status >= 200 && status < 300) violations.isolation.push({ at: t0, user: user.email, key, status });
  if (kind === 'invalidGrant' && status >= 200 && status < 300) violations.invalidGrant.push({ at: t0, user: user.email, key, status });
  return { status, json, ok };
}

// --- users ---------------------------------------------------------------------------------------
async function login(user) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await call(user, 'POST', '/api/v1/auth/login', '/auth/login', { body: { email: user.email, password: user.password } });
    if (res.status === 200 && user.setCookie) {
      user.cookie = user.setCookie.map((c) => c.split(';')[0]).join('; ');
      logins.ok++;
      return true;
    }
  }
  logins.failed++;
  return false;
}

const homeOf = (id) => plan.homeById[id];
const think = () => sleep(between(5000, 15_000));

async function browse(user) {
  const home = user.role === 'PLATFORM_SUPER_ADMIN' ? pick(plan.homes) : homeOf(pick(user.homes));
  const choices = [
    () => call(user, 'GET', '/api/v1/auth/me', '/auth/me'),
    () => call(user, 'GET', '/api/v1/homes', '/homes'),
    () => call(user, 'GET', `/api/v1/homes/${home.homeId}`, '/homes/:id'),
    () => call(user, 'GET', `/api/v1/homes/${home.homeId}/hub`, '/homes/:id/hub'),
    () => call(user, 'GET', `/api/v1/homes/${home.homeId}/devices`, '/homes/:id/devices'),
    () => call(user, 'GET', `/api/v1/homes/${home.homeId}/grants`, '/homes/:id/grants'),
    () => call(user, 'GET', '/api/v1/grants', '/grants'),
  ];
  if (user.role === 'PLATFORM_SUPPORT') choices.push(() => call(user, 'GET', '/api/v1/fleet/summary', '/fleet/summary'));
  return pick(choices)();
}

async function adminAction(user) {
  if (Math.random() < 1 / 60) return call(user, 'POST', '/api/v1/audit/verify', '/audit/verify');
  return pick([
    () => call(user, 'GET', '/api/v1/homes', '/homes'),
    () => call(user, 'GET', '/api/v1/fleet/summary', '/fleet/summary'),
    () => call(user, 'GET', '/api/v1/staff', '/staff'),
    () => call(user, 'GET', '/api/v1/audit?limit=100', '/audit'),
    () => call(user, 'GET', '/api/v1/grants', '/grants'),
    () => call(user, 'GET', '/api/v1/rollouts', '/rollouts'),
    () => call(user, 'GET', '/api/v1/releases', '/releases'),
    () => call(user, 'GET', '/api/v1/audit/checkpoints', '/audit/checkpoints'),
  ])();
}

async function isolationProbe(user) {
  const assigned = new Set(user.homes);
  const other = pick(plan.homes.filter((h) => !assigned.has(h.homeId)));
  const denied = [403, 404];
  return pick([
    () => call(user, 'GET', `/api/v1/homes/${other.homeId}`, '/homes/:id (unassigned)', { expect: denied, kind: 'isolation' }),
    () => call(user, 'GET', `/api/v1/homes/${other.homeId}/devices`, '/homes/:id/devices (unassigned)', { expect: denied, kind: 'isolation' }),
    () => call(user, 'GET', `/api/v1/homes/${other.homeId}/hub`, '/homes/:id/hub (unassigned)', { expect: denied, kind: 'isolation' }),
    () =>
      call(user, 'POST', `/api/v1/homes/${other.homeId}/grants`, '/homes/:id/grants (unassigned)', {
        body: { deviceIds: [other.devices[0]], actions: ['device.command'], reason: 'isolation probe', durationMinutes: 15 },
        expect: denied,
        kind: 'isolation',
      }),
  ])();
}

async function invalidGrantProbe(user) {
  const ended = user.endedGrants.length ? pick(user.endedGrants) : null;
  const homeId = ended?.homeId ?? pick(user.homes);
  const grantId = ended?.grantId ?? randomUUID();
  const entityId = `${homeOf(homeId).devices[0]}.switch.relay_1`;
  return call(user, 'POST', `/api/v1/homes/${homeId}/grants/${grantId}/commands`, '/homes/:id/grants/:id/commands (ended or unknown grant)', {
    body: { entityId, value: true },
    expect: [403, 404, 409],
    kind: 'invalidGrant',
  });
}

/** Request access, wait for the owner's approval on the hub, use it, finish. */
async function supportSession(user) {
  const home = homeOf(pick(user.homes));
  const devices = [...home.devices].sort(() => Math.random() - 0.5).slice(0, 2);
  const req = await call(user, 'POST', `/api/v1/homes/${home.homeId}/grants`, '/homes/:id/grants', {
    body: { deviceIds: devices, actions: ['device.command', 'diagnostics.read'], reason: 'load test: customer asked for help with a relay', durationMinutes: 15 },
    expect: [201],
  });
  if (!req.ok) return;
  sessions.requested++;
  const grantId = req.json.grantId;
  const base = `/api/v1/homes/${home.homeId}/grants/${grantId}`;
  const asked = Date.now();
  let active = false;
  while (!stopping && Date.now() - asked < 90_000) {
    await sleep(5000); // the portal polls an open grant every 5 s
    const g = await call(user, 'GET', base, '/homes/:id/grants/:id');
    if (g.json?.status === 'active' && g.json?.ownerNotified) {
      active = true;
      break;
    }
  }
  if (!active) {
    sessions.neverActive++;
  } else {
    sessions.active++;
    sessions.timeToActiveMs.push(Date.now() - asked);
    const actions = Math.floor(between(6, 11));
    for (let i = 0; i < actions && !stopping; i++) {
      await think();
      const r = Math.random();
      if (r < 0.5) {
        sessions.commands++;
        await call(user, 'POST', `${base}/commands`, '/homes/:id/grants/:id/commands', { body: { entityId: `${pick(devices)}.switch.relay_1`, value: Math.random() < 0.5 }, expect: [202, 409] });
        await sleep(1000);
        await call(user, 'GET', `${base}/commands`, '/homes/:id/grants/:id/commands (list)');
      } else if (r < 0.7) {
        sessions.diagnostics++;
        await call(user, 'POST', `${base}/diagnostics`, '/homes/:id/grants/:id/diagnostics');
      } else {
        await browse(user);
      }
    }
  }
  const end = await call(user, 'POST', `${base}/revoke`, '/homes/:id/grants/:id/revoke', { body: { reason: 'support session finished', outcome: active ? 'completed' : 'revoked' }, expect: [200, 409] });
  if (end.status === 200) sessions.finished++;
  user.endedGrants.push({ homeId: home.homeId, grantId });
  if (user.endedGrants.length > 5) user.endedGrants.shift();
}

async function runUser(user, startDelay) {
  await sleep(startDelay);
  if (!(await login(user))) return;
  while (!stopping) {
    await think();
    if (stopping) break;
    if (user.role === 'PLATFORM_SUPER_ADMIN') {
      await adminAction(user);
      continue;
    }
    const r = Math.random();
    if (r < 0.8) await browse(user);
    else if (r < 0.9) await supportSession(user);
    else if (r < 0.95) await isolationProbe(user);
    else await invalidGrantProbe(user);
  }
}

async function fleetSampler(admin) {
  while (!stopping) {
    await sleep(60_000 - (Date.now() % 60_000));
    if (stopping) break;
    const t = Date.now();
    const res = await call(admin, 'GET', '/api/v1/fleet/summary', '/fleet/summary');
    if (inWindow(t)) fleetSamples.push({ at: t, online: res.json?.online ?? null, hubs: res.json?.hubs ?? null, status: res.status });
  }
}

process.on('message', async (m) => {
  if (m?.type === 'start') {
    measureStart = m.measureStart;
    measureEnd = m.measureEnd;
    const users = plan.users.map((u) => ({ ...u, cookie: null, setCookie: null, endedGrants: [] }));
    const runners = users.map((u) => runUser(u, between(0, m.rampMs)));
    const sampler = { ...plan.sampler, cookie: null, setCookie: null, endedGrants: [] };
    if (await login(sampler)) void fleetSampler(sampler);
    await sleep(measureEnd - Date.now());
    stopping = true;
    await Promise.race([Promise.all(runners), sleep(30_000)]);
    const endpoints = {};
    const { summarise } = await import('./lib.mjs');
    for (const [k, v] of [...latencies.entries()].sort()) endpoints[k] = summarise(v);
    process.send({
      type: 'results',
      results: { overall: summarise(all), endpoints, counts, unexpectedByKind, unexpected, violations, sessions: { ...sessions, timeToActiveMs: summarise(sessions.timeToActiveMs) }, logins, fleetSamples },
    });
  }
});
process.send?.({ type: 'loaded' });
