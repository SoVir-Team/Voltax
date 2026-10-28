import { createECDH, randomBytes, randomUUID } from 'node:crypto';
import webpush from 'web-push';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { HubAuditRecord } from '@voltax/contracts';
import { GENESIS_HASH } from '../src/audit.js';
import { AuditExport, verifyExportedObject } from '../src/audit-export.js';
import { WebPushSender, type PushSender } from '../src/channels.js';
import { hubAuditHash as hubChainHash } from '../src/hub-audit.js'; // same formula as backend/hub (proven by e2e.test.ts)
import type { ObjectStore } from '../src/s3.js';
import { startCloud, type TestCloud } from './helpers.js';

let c: TestCloud;
beforeAll(async () => {
  c = await startCloud();
});
afterAll(async () => {
  await c.close();
});

/** Builds a valid hub audit chain the same way backend/hub does. */
function hubChain(n: number, start = 1, prev = GENESIS_HASH): HubAuditRecord[] {
  const out: HubAuditRecord[] = [];
  for (let i = 0; i < n; i++) {
    const base = { id: randomUUID(), at: Date.now() + i, actor: 'client:abc', action: `test.${start + i}`, outcome: 'ok' as const, target: null, details: { i } };
    const hash = hubChainHash(prev, base);
    out.push({ seq: start + i, ...base, prevHash: prev, hash });
    prev = hash;
  }
  return out;
}

describe('hub audit copies', () => {
  it('stores a valid chain, ignores exact duplicates, and links batches together', async () => {
    const home = await c.addHome();
    await c.addHub(home, 'hub-audit-a');
    const chain = hubChain(6);
    expect(await c.hubAudit.ingest('hub-audit-a', chain.slice(0, 3))).toMatchObject({ stored: 3, breaks: 0 });
    expect(await c.hubAudit.ingest('hub-audit-a', chain.slice(0, 5))).toMatchObject({ stored: 2, duplicates: 3, breaks: 0 });
    expect(await c.hubAudit.summary('hub-audit-a')).toEqual({ records: 5, lastSeq: 5, breaks: 0 });
  });

  it('flags a record whose content no longer matches its hash, and a gap in the sequence', async () => {
    const chain = hubChain(4);
    chain[1] = { ...chain[1]!, actor: 'someone-else' }; // edited after hashing
    const res = await c.hubAudit.ingest('hub-audit-b', [chain[0]!, chain[1]!, chain[3]!]);
    expect(res.breaks).toBe(2); // seq 2 does not recompute; seq 4 follows a gap
    const alerts = (await c.audit.list({ limit: 500 })).filter((r) => r.action === 'hub_audit.chain_break' && r.actor === 'hub:hub-audit-b');
    expect(alerts.map((a) => a.details.seq)).toEqual([2, 4]);
  });

  it('a hub that rewrites history is caught: the copy is kept and the conflict raised', async () => {
    const chain = hubChain(2);
    await c.hubAudit.ingest('hub-audit-c', chain);
    const rewritten = hubChain(2); // same seq numbers, different content
    expect(await c.hubAudit.ingest('hub-audit-c', rewritten)).toMatchObject({ conflicts: 2, stored: 0 });
    expect((await c.hubAudit.list('hub-audit-c')).map((r) => r.hash)).toEqual(chain.map((r) => r.hash));
  });
});

describe('signed checkpoints', () => {
  it('verify passes on an untouched log and every checkpoint signature checks out', async () => {
    await c.audit.append({ actor: 'system', action: 'test.cp', outcome: 'ok' });
    expect(await c.checkpoints.create()).not.toBeNull();
    expect(await c.checkpoints.create()).toBeNull(); // nothing new since the last one
    const v = await c.checkpoints.verify(c.checkpointPublicKeyPem);
    expect(v).toMatchObject({ ok: true, problems: [] });
  });

  it('a full rewrite that re-hashes the whole chain is still caught by the checkpoints', async () => {
    const own = await startCloud();
    try {
      for (let i = 0; i < 3; i++) await own.audit.append({ actor: 'system', action: `cp.${i}`, outcome: 'ok' });
      await own.checkpoints.create();
      // Attacker with database owner rights: edits a record and recomputes every hash after it.
      await own.db.exec('ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_update');
      const rows = await own.db.query<{ seq: number; id: string; at: number; actor: string; action: string; outcome: string; target: string | null; home_id: string | null; details: string }>(
        'SELECT * FROM audit_log ORDER BY seq',
      );
      const { auditHash } = await import('../src/audit.js');
      let prev = GENESIS_HASH;
      for (const r of rows) {
        const actor = r.action === 'cp.1' ? 'innocent' : r.actor;
        const hash = auditHash(prev, { ...r, actor, homeId: r.home_id }, r.details);
        await own.db.query('UPDATE audit_log SET actor = $2, prev_hash = $3, hash = $4 WHERE seq = $1', [r.seq, actor, prev, hash]);
        prev = hash;
      }
      expect((await own.audit.verify()).ok).toBe(true); // the chain alone is fooled...
      const v = await own.checkpoints.verify(own.checkpointPublicKeyPem);
      expect(v.ok).toBe(false); // ...the signed checkpoint is not
      expect(v.problems.join()).toMatch(/changed after it was checkpointed/);
    } finally {
      await own.close();
    }
  });
});

describe('off-device export', () => {
  class MemoryStore implements ObjectStore {
    objects = new Map<string, string>();
    failNext = false;
    async put(key: string, body: string) {
      if (this.failNext) {
        this.failNext = false;
        throw new Error('bucket unavailable');
      }
      if (this.objects.has(key)) throw new Error('object exists (WORM)');
      this.objects.set(key, body);
    }
    async get(key: string) {
      return this.objects.get(key) ?? null;
    }
  }

  it('exports the chain in order with checkpoints; each object verifies and links to the previous one', async () => {
    const store = new MemoryStore();
    const exporter = new AuditExport(c.db, c.audit, c.checkpoints, store);
    expect(await exporter.runAll()).toBeGreaterThan(0);
    await c.audit.append({ actor: 'system', action: 'test.after', outcome: 'ok' });
    expect(await exporter.runAll()).toBeGreaterThan(0);
    const keys = [...store.objects.keys()].sort();
    expect(keys.length).toBeGreaterThanOrEqual(2);
    let prev: string | undefined = GENESIS_HASH;
    for (const key of keys) {
      const v = verifyExportedObject(store.objects.get(key)!, prev);
      expect(v, key).toMatchObject({ ok: true });
      expect(v.checkpoint).not.toBeNull();
      prev = v.head ?? prev;
    }
    const [head] = await c.db.query<{ m: number }>('SELECT max(seq) AS m FROM audit_log');
    expect(await exporter.cursor()).toBe(Number(head!.m));
  });

  it('a failed upload does not move the cursor (nothing is skipped) and is audited', async () => {
    const store = new MemoryStore();
    const exporter = new AuditExport(c.db, c.audit, c.checkpoints, store);
    await exporter.runAll();
    await c.audit.append({ actor: 'system', action: 'test.fail', outcome: 'ok' });
    const before = await exporter.cursor();
    store.failNext = true;
    await expect(exporter.runOnce()).rejects.toThrow(/bucket unavailable/);
    expect(await exporter.cursor()).toBe(before);
    const retry = await exporter.runOnce();
    expect(retry?.records).toBeGreaterThanOrEqual(1);
  });

  it('detects a tampered exported object', async () => {
    const store = new MemoryStore();
    {
      const exporter = new AuditExport(c.db, c.audit, c.checkpoints, store);
      await c.audit.append({ actor: 'system', action: 'test.tamper', outcome: 'ok' });
      await exporter.runAll();
      const [key] = [...store.objects.keys()];
      const tampered = store.objects.get(key!)!.replace('"outcome":"ok"', '"outcome":"error"');
      expect(verifyExportedObject(tampered).ok).toBe(false);
    }
  });
});

describe('staff Web Push', () => {
  const sent: Array<{ endpoint: string; payload: string }> = [];
  const fake: PushSender = {
    async send(sub, payload) {
      sent.push({ endpoint: sub.endpoint, payload });
      return { statusCode: sub.endpoint.includes('gone') ? 410 : 201 };
    },
  };
  const keys = { p256dh: Buffer.from(createECDH('prime256v1').generateKeys()).toString('base64url'), auth: randomBytes(16).toString('base64url') };

  it('only accepts real browser push services (no server-side request forgery)', async () => {
    const pc = await startCloud({ extra: { push: { sender: fake, publicKey: 'BPub' } } });
    try {
      const s = await pc.addStaff('PLATFORM_SUPPORT');
      for (const endpoint of ['https://169.254.169.254/latest', 'https://localhost/x', 'http://fcm.googleapis.com/fcm/send/x', 'https://evil.example/push']) {
        expect((await pc.req('POST', '/api/v1/push/subscriptions', { cookie: s.cookie, body: { endpoint, keys } })).status, endpoint).toBe(400);
      }
      expect((await pc.req('POST', '/api/v1/push/subscriptions', { cookie: s.cookie, body: { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys } })).status).toBe(201);
      expect((await pc.req('GET', '/api/v1/push', { cookie: s.cookie })).body).toMatchObject({ enabled: true, publicKey: 'BPub', subscriptions: 1 });
    } finally {
      await pc.close();
    }
  });

  it('notifies the grantee when the owner decides, and forgets subscriptions the browser dropped', async () => {
    const pc = await startCloud({ extra: { push: { sender: fake, publicKey: 'BPub' } } });
    try {
      const home = await pc.addHome();
      await pc.addHub(home, 'hub-push');
      const s = await pc.addStaff('PLATFORM_SUPPORT');
      await pc.assign(s.staffId, home);
      await pc.push.subscribe(s.staffId, { endpoint: 'https://fcm.googleapis.com/fcm/send/live', keys });
      await pc.push.subscribe(s.staffId, { endpoint: 'https://fcm.googleapis.com/fcm/send/gone', keys });
      const res = await pc.req('POST', `/api/v1/homes/${home}/grants`, { cookie: s.cookie, body: { deviceIds: ['kitchen'], actions: ['diagnostics.read'], reason: 'checking the hub health', durationMinutes: 30 } });
      sent.length = 0;
      await pc.route('hub-push', { type: 'grant.status', grantId: res.body.grantId, status: 'active', at: Date.now(), startNoticeAt: Date.now() });
      await new Promise((r) => setTimeout(r, 50));
      expect(sent.map((m) => JSON.parse(m.payload).body)).toEqual(['The owner approved your support request.', 'The owner approved your support request.']);
      expect(await pc.push.count(s.staffId)).toBe(1);
    } finally {
      await pc.close();
    }
  });

  it('real Web Push encryption: the payload decrypts with the browser keys (RFC 8291) and carries a VAPID JWT', async () => {
    const vapid = webpush.generateVAPIDKeys();
    const browser = createECDH('prime256v1');
    browser.generateKeys();
    const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/test', keys: { p256dh: browser.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } };
    const details = webpush.generateRequestDetails(sub, JSON.stringify({ title: 'VOLTEX', body: 'hello' }), {
      vapidDetails: { subject: 'mailto:ops@voltex.example', publicKey: vapid.publicKey, privateKey: vapid.privateKey },
    });
    expect(details.headers['Content-Encoding']).toBe('aes128gcm');
    expect(String(details.headers.Authorization)).toMatch(/^vapid t=.+, k=/);
    const ece = (await import('http_ece')).default as { decrypt: (buf: Buffer, opts: Record<string, unknown>) => Buffer };
    const plain = ece.decrypt(details.body as Buffer, { version: 'aes128gcm', privateKey: browser, authSecret: sub.keys.auth });
    expect(JSON.parse(plain.toString())).toEqual({ title: 'VOLTEX', body: 'hello' });
    expect(new WebPushSender({ subject: 'mailto:ops@voltex.example', ...vapid })).toBeTruthy();
  });
});
