import { createHash, createHmac } from 'node:crypto';

export interface S3Config {
  endpoint: string; // e.g. https://s3.eu-central-1.amazonaws.com or http://127.0.0.1:9000 (MinIO)
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Days each object is locked (COMPLIANCE mode) when the bucket has Object Lock enabled; 0 = none. */
  lockDays?: number;
}

/** Where the cloud audit export writes (off-device copy). */
export interface ObjectStore {
  put(key: string, body: string): Promise<string | null | void>;
  get(key: string): Promise<string | null>;
}

const sha256hex = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const hmac = (key: string | Buffer, data: string) => createHmac('sha256', key).update(data).digest();

/** Minimal S3 client (path-style, AWS Signature V4) for PutObject/GetObject. Works with AWS and MinIO. */
export class S3Store implements ObjectStore {
  constructor(private cfg: S3Config) {}

  /** Stores an object; returns its version id when the bucket is versioned (always with Object Lock). */
  async put(key: string, body: string): Promise<string | null> {
    const extra: Record<string, string> = { 'content-type': 'application/x-ndjson', 'content-md5': createHash('md5').update(body).digest('base64') };
    if (this.cfg.lockDays) {
      extra['x-amz-object-lock-mode'] = 'COMPLIANCE';
      extra['x-amz-object-lock-retain-until-date'] = new Date(Date.now() + this.cfg.lockDays * 86_400_000).toISOString();
    }
    const res = await this.request('PUT', key, body, extra);
    if (!res.ok) throw new Error(`S3 put ${key} failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
    return res.headers.get('x-amz-version-id');
  }

  async get(key: string, versionId?: string): Promise<string | null> {
    const res = await this.request('GET', key, '', {}, versionId ? `versionId=${encodeURIComponent(versionId)}` : '');
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`S3 get ${key} failed: ${res.status}`);
    return res.text();
  }

  /** Creates the bucket with Object Lock (and so versioning) enabled. Setup/ops tooling, not used at runtime. */
  async createBucket(): Promise<void> {
    const res = await this.request('PUT', '', '', { 'x-amz-bucket-object-lock-enabled': 'true' });
    if (!res.ok) throw new Error(`S3 create bucket failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  }

  /** Version and retention of an object (null when absent). */
  async head(key: string): Promise<{ versionId: string | null; lockMode: string | null; retainUntil: string | null } | null> {
    const res = await this.request('HEAD', key, '');
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`S3 head ${key} failed: ${res.status}`);
    const h = (name: string) => res.headers.get(name);
    return { versionId: h('x-amz-version-id'), lockMode: h('x-amz-object-lock-mode'), retainUntil: h('x-amz-object-lock-retain-until-date') };
  }

  /** Exposed for tests that prove locked objects cannot be deleted. */
  async delete(key: string, versionId?: string): Promise<Response> {
    return this.request('DELETE', key, '', {}, versionId ? `versionId=${encodeURIComponent(versionId)}` : '');
  }

  private async request(method: string, key: string, body: string, extra: Record<string, string> = {}, query = ''): Promise<Response> {
    const url = new URL(this.cfg.endpoint);
    const path = key ? `/${this.cfg.bucket}/${key.split('/').map(encodeURIComponent).join('/')}` : `/${this.cfg.bucket}`;
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const date = amzDate.slice(0, 8);
    const payloadHash = sha256hex(body);
    const headers: Record<string, string> = { host: url.host, 'x-amz-date': amzDate, 'x-amz-content-sha256': payloadHash, ...extra };
    const names = Object.keys(headers).map((h) => h.toLowerCase()).sort();
    const canonicalHeaders = names.map((h) => `${h}:${String(headers[h]).trim()}\n`).join('');
    const signedHeaders = names.join(';');
    const canonicalRequest = [method, path, query, canonicalHeaders, signedHeaders, payloadHash].join('\n');
    const scope = `${date}/${this.cfg.region}/s3/aws4_request`;
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n');
    const kDate = hmac(`AWS4${this.cfg.secretAccessKey}`, date);
    const kSigning = hmac(hmac(hmac(kDate, this.cfg.region), 's3'), 'aws4_request');
    const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');
    headers.authorization = `AWS4-HMAC-SHA256 Credential=${this.cfg.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
    delete headers.host;
    return fetch(`${url.origin}${path}${query ? `?${query}` : ''}`, { method, headers, ...(method === 'PUT' ? { body } : {}) });
  }
}
