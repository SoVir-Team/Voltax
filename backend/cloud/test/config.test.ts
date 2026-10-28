import { describe, expect, it } from 'vitest';
import { loadCloudConfig } from '../src/config.js';

const base = { DATABASE_URL: 'postgres://app@db/voltax', CLOUD_DATA_KEY: 'a'.repeat(64) };

describe('cloud configuration', () => {
  it('a minimal configuration starts with every optional channel off and safe defaults', () => {
    const c = loadCloudConfig(base);
    expect(c).toMatchObject({ COOKIE_SECURE: true, MIGRATE_ON_START: false, INTERNAL_PORT: 0, S3_LOCK_DAYS: 365 });
    expect(c.CLOUD_BROKER_URL ?? c.SMTP_URL ?? c.VAPID_PUBLIC_KEY ?? c.S3_ENDPOINT).toBeUndefined();
  });

  it('empty values from an env file count as unset', () => {
    expect(loadCloudConfig({ ...base, SMTP_URL: '', SMTP_FROM: '' }).SMTP_URL).toBeUndefined();
  });

  it('settings that only work together are required together, and errors never echo secret values', () => {
    const secret = 'smtp://user:Sup3rS3cret@mail.example:587';
    let message = '';
    try {
      loadCloudConfig({ ...base, SMTP_URL: secret });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/SMTP_FROM: required with SMTP_URL/);
    expect(message).not.toContain('Sup3rS3cret');
    expect(() => loadCloudConfig({ ...base, S3_ENDPOINT: 'https://s3.example', S3_BUCKET: 'b' })).toThrow(/S3_ACCESS_KEY_ID.*S3_SECRET_ACCESS_KEY|S3_SECRET_ACCESS_KEY/);
    expect(() => loadCloudConfig({ ...base, VAPID_PUBLIC_KEY: 'x' })).toThrow(/VAPID_PRIVATE_KEY/);
    expect(() => loadCloudConfig({ ...base, CLOUD_BROKER_URL: 'mqtts://emqx:8883' })).toThrow(/CLOUD_BROKER_PASSWORD/);
  });

  it('the broker auth API needs a long shared secret and the service password', () => {
    expect(() => loadCloudConfig({ ...base, INTERNAL_PORT: '8081', CLOUD_BROKER_URL: 'mqtt://emqx:1883', CLOUD_BROKER_PASSWORD: 'p', BROKER_AUTH_SECRET: 'short' })).toThrow(/BROKER_AUTH_SECRET/);
    expect(() => loadCloudConfig({ ...base, INTERNAL_PORT: '8081', BROKER_AUTH_SECRET: 'x'.repeat(40) })).toThrow(/CLOUD_BROKER_PASSWORD/);
    expect(loadCloudConfig({ ...base, INTERNAL_PORT: '8081', CLOUD_BROKER_URL: 'mqtt://emqx:1883', CLOUD_BROKER_PASSWORD: 'p', BROKER_AUTH_SECRET: 'x'.repeat(40) }).INTERNAL_PORT).toBe(8081);
  });
});
