// Trusted broker-only COS signing and HEAD metadata; never transfers image bodies.
import { createHmac, createHash } from 'node:crypto';
import { readFileSync, lstatSync } from 'node:fs';

const sha1 = value => createHash('sha1').update(value).digest('hex');
const encode = value => encodeURIComponent(String(value)).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
const canonical = values => Object.keys(values).sort().map(key => encode(key.toLowerCase()) + '=' + encode(values[key])).join('&');

export class CosStore {
  config: any;
  fetcher: any;
  now: any;
  host: any;
  constructor(config, { fetcher = fetch, now = Date.now } = {}) {
    if (!/^[a-z0-9][a-z0-9-]{0,61}-[0-9]{5,20}$/.test(config.bucket || '') ||
        !/^[a-z]{2}-[a-z0-9-]{2,32}$/.test(config.region || '') || !config.secret_id || !config.secret_key) {
      throw new Error('Invalid private COS configuration');
    }
    this.config = config; this.fetcher = fetcher; this.now = now;
    this.host = `${config.bucket}.cos.${config.region}.myqcloud.com`;
  }
  static fromFile(filename) {
    if (!filename) return null;
    const stat = lstatSync(filename);
    if (!stat.isFile() || stat.mode & 0o077 || stat.uid !== process.getuid?.()) throw new Error('COS configuration must be private');
    const values = {}; let common = false;
    for (const line of readFileSync(filename, 'utf8').split(/\r?\n/)) {
      const text = line.trim();
      if (!text || text.startsWith('#') || text.startsWith(';')) continue;
      if (text.startsWith('[')) { common = text === '[common]'; continue; }
      const match = /^([a-z_]+)\s*=\s*(.*)$/.exec(text);
      if (common && match) values[match[1]] = match[2].trim();
    }
    return new CosStore(values);
  }
  signed(method, key, headers = {}, ttl = 300) {
    const current = Math.floor(this.now() / 1000), keyTime = `${current - 60};${current + ttl}`;
    const values = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
    values.host = this.host;
    const pathname = '/' + key.split('/').map(encode).join('/');
    const httpString = `${method.toLowerCase()}\n${pathname}\n\n${canonical(values)}\n`;
    const signKey = createHmac('sha1', this.config.secret_key).update(keyTime).digest('hex');
    const signature = createHmac('sha1', signKey).update(`sha1\n${keyTime}\n${sha1(httpString)}\n`).digest('hex');
    const auth = new URLSearchParams({ 'q-sign-algorithm': 'sha1', 'q-ak': this.config.secret_id,
      'q-sign-time': keyTime, 'q-key-time': keyTime, 'q-header-list': Object.keys(values).sort().join(';'),
      'q-url-param-list': '', 'q-signature': signature });
    return { url: `https://${this.host}${pathname}?${auth}`, method, headers, expiresAt: (current + ttl) * 1000 };
  }
  async head(key, etag) {
    const headers = etag ? { 'If-Match': etag } : {};
    const plan = this.signed('HEAD', key, headers);
    // No redirects: a signed object key must never turn into an arbitrary fetch.
    const response = await this.fetcher(plan.url, { method: 'HEAD', headers, redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error('COS object metadata unavailable');
    const length = response.headers.get('content-length');
    if (!/^\d+$/.test(length || '') || !Number.isSafeInteger(Number(length))) throw new Error('Invalid COS object size');
    return { bytes: Number(length), etag: response.headers.get('etag'), mime: response.headers.get('content-type'),
      sha256: response.headers.get('x-cos-meta-sha256') };
  }
}
