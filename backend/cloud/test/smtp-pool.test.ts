import { createServer, type Server } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { SmtpEmail } from '../src/channels.js';

// Owner notices gate remote support (fail-closed), so their throughput matters: a new SMTP
// connection per notice costs a TCP + greeting (+ TLS) round trip each time and, under load, queued
// start notices kept support sessions waiting (docs/testing/load-test-results-*). Connections are pooled.

let server: Server | undefined;
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

/** Minimal SMTP server: accepts everything, counts connections and messages. */
async function fakeSmtp(): Promise<{ url: string; connections: () => number; messages: () => number }> {
  let connections = 0;
  let messages = 0;
  server = createServer((socket) => {
    connections++;
    let data = false;
    socket.write('220 fake ESMTP\r\n');
    socket.on('data', (chunk) => {
      for (const line of chunk.toString().split('\r\n').filter(Boolean)) {
        if (data) {
          if (line === '.') {
            data = false;
            messages++;
            socket.write('250 queued\r\n');
          }
          continue;
        }
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === 'EHLO' || cmd === 'HELO') socket.write('250 fake\r\n');
        else if (cmd === 'DATA') {
          data = true;
          socket.write('354 go\r\n');
        } else if (cmd === 'QUIT') socket.end('221 bye\r\n');
        else socket.write('250 ok\r\n');
      }
    });
    socket.on('error', () => {});
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  return { url: `smtp://127.0.0.1:${port}`, connections: () => connections, messages: () => messages };
}

describe('SMTP email channel', () => {
  it('reuses connections instead of opening one per notice', async () => {
    const smtp = await fakeSmtp();
    const mail = new SmtpEmail({ url: smtp.url, from: 'support@voltex.example.test' });
    try {
      for (let i = 0; i < 5; i++) await mail.send({ to: `owner-${i}@example.test`, subject: 'VOLTEX support started', text: 'hello' });
      expect(smtp.messages()).toBe(5);
      expect(smtp.connections()).toBe(1);
    } finally {
      mail.close();
    }
  });
});
