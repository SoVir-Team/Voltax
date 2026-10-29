import { createServer, type Server } from 'node:net';
import { Aedes } from 'aedes';
import mqtt from 'mqtt';
import { afterEach, describe, expect, it } from 'vitest';
import { BrokerLink, CLOUD_SERVICE_USER } from '../src/broker.js';
import { freePort } from './broker-helper.js';

// The cloud's broker connection must survive a broker that is not ready yet (cold start of the whole
// stack: EMQX's auth webhook is the cloud itself), and must not stay connected-but-deaf when a
// subscription is refused while EMQX is still loading its authorisation source.

const log = { info: () => {}, warn: () => {} };
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

async function until(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function broker(port: number, opts: { refuseSubscriptions?: number } = {}): Promise<void> {
  let refuse = opts.refuseSubscriptions ?? 0;
  const b = await Aedes.createBroker({
    authorizeSubscribe: (_client, sub, done) => {
      if (refuse > 0) {
        refuse--;
        return done(null, null); // refused (SUBACK 0x80), like EMQX before its authz source is up
      }
      done(null, sub);
    },
  });
  const server: Server = createServer(b.handle);
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
  closers.push(() => new Promise<void>((r) => b.close(() => server.close(() => r()))));
}

async function hubSaysOnline(port: number, hubId: string): Promise<void> {
  const hub = await mqtt.connectAsync(`mqtt://127.0.0.1:${port}`, { username: hubId, password: 'x' });
  await hub.publishAsync(`voltax-cloud/${hubId}/status`, 'online', { qos: 1, retain: true });
  await hub.endAsync();
}

describe('cloud broker link', () => {
  it('starts while the broker is unreachable, refuses to publish, then connects when the broker appears', async () => {
    const port = await freePort();
    const link = new BrokerLink({ url: `mqtt://127.0.0.1:${port}`, password: 'x', startTimeoutMs: 300, reconnectMs: 200 }, async () => {}, log);
    closers.push(() => link.stop());
    await link.start(); // resolves instead of failing the whole cloud
    expect(link.connected).toBe(false);
    await expect(link.publish('hub-one', { payload: '{}', sig: 'x' })).rejects.toThrow('not connected');

    await broker(port);
    await until(() => link.connected);
    await hubSaysOnline(port, 'hub-one');
    await until(() => link.online.get('hub-one') === true);
  });

  it('retries a refused subscription until it is granted', async () => {
    const port = await freePort();
    await broker(port, { refuseSubscriptions: 2 });
    const link = new BrokerLink({ url: `mqtt://127.0.0.1:${port}`, password: 'x', reconnectMs: 200, resubscribeMs: 100 }, async () => {}, log);
    closers.push(() => link.stop());
    await link.start();
    await hubSaysOnline(port, 'hub-two');
    await until(() => link.online.get('hub-two') === true);
  });

  it('logs in as the cloud service account', () => {
    expect(CLOUD_SERVICE_USER).toBe('voltax-cloud-service');
  });
});

describe('cloud logging of the broker link', () => {
  it('reports an unreachable broker through the cloud server log (not a silent logger)', async () => {
    const { Writable } = await import('node:stream');
    const { randomBytes, generateKeyPairSync } = await import('node:crypto');
    const { createCloud } = await import('../src/cloud.js');
    const { pgliteDb } = await import('../src/db.js');
    const lines: string[] = [];
    const stream = new Writable({ write: (chunk, _enc, cb) => (lines.push(String(chunk)), cb()) });
    const cloud = await createCloud({
      db: await pgliteDb(),
      dataKey: randomBytes(32),
      commandKeyPem: generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      api: { cookieSecure: false },
      broker: { url: `mqtt://127.0.0.1:${await freePort()}`, password: 'x', startTimeoutMs: 200 },
      server: { logger: { level: 'info', stream } },
    });
    closers.push(() => cloud.close());
    await cloud.start();
    expect(lines.join('')).toContain('cloud broker not reachable yet');
  });
});
