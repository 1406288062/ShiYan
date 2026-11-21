import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {mkdir, chmod, readFile, writeFile, rename, stat, truncate, open} from 'node:fs/promises';

const MAX_IMAGE = 13.5 * 1024 * 1024;
const MAX_CHUNK = 48 * 1024;
const SUFFIXES = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const SHA = /^[0-9a-f]{64}$/;
const locks = new Map();
const digest = (bytes: any) => createHash('sha256').update(bytes).digest('hex');
const failure = (message: any, status = 400) => Object.assign(new Error(message), {status});
const absent = (error: any) => error?.code === 'ENOENT';

// One lock per owner/content pair, including across instances in this process.
async function locked(key: any, action: any) {
  const previous = locks.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(action);
  const settled = current.then(() => {}, () => {});
  locks.set(key, settled);
  try { return await current; }
  finally { if (locks.get(key) === settled) locks.delete(key); }
}

export class JobImageUploads {
  root: string;
  constructor(dataDirectory: any) {
    this.root = path.resolve(dataDirectory, 'job-image-uploads');
  }

  location(owner: any, id: any) {
    if (typeof owner !== 'string' || !owner || typeof id !== 'string' || !SHA.test(id)) {
      throw failure('图片上传标识无效');
    }
    return path.join(this.root, digest(owner), id);
  }

  async prepare(directory: any) {
    for (const target of [this.root, path.dirname(directory), directory]) {
      await mkdir(target, {recursive: true, mode: 0o700});
      await chmod(target, 0o700);
    }
  }

  async load(directory: any, id: any) {
    let metadata;
    try { metadata = JSON.parse(await readFile(path.join(directory, 'metadata.json'), 'utf8')); }
    catch (error) {
      if (absent(error)) throw failure('图片尚未上传', 404);
      throw failure('图片上传记录损坏', 409);
    }
    if (metadata.id !== id || metadata.sha256 !== id || !SUFFIXES.has(metadata.suffix)
        || !Number.isSafeInteger(metadata.total) || metadata.total < 1 || metadata.total > MAX_IMAGE
        || !Number.isSafeInteger(metadata.offset) || metadata.offset < 0 || metadata.offset > metadata.total
        || metadata.complete !== (metadata.offset === metadata.total)) {
      throw failure('图片上传记录损坏', 409);
    }
    const file = path.join(directory, 'data');
    let size;
    try { size = (await stat(file)).size; }
    catch (error) {
      if (!absent(error) || metadata.offset) throw failure('图片上传数据不完整', 409);
      size = 0;
    }
    if (size < metadata.offset) throw failure('图片上传数据不完整', 409);
    // The metadata rename is the commit point. Discard an interrupted append.
    if (size > metadata.offset) await truncate(file, metadata.offset);
    return metadata;
  }

  response(metadata: any) {
    const {id, offset, total, suffix, complete} = metadata;
    return {ok: true, upload: {id, offset, total, suffix, complete}};
  }

  async save(directory: any, metadata: any) {
    const temporary = path.join(directory, `metadata-${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(metadata), {mode: 0o600, flag: 'wx'});
    await rename(temporary, path.join(directory, 'metadata.json'));
  }

  async inspect(owner: any, id: any) {
    const directory = this.location(owner, id);
    return locked(directory, async () => this.response(await this.load(directory, id)));
  }

  async append(owner: any, id: any, input: any) {
    const directory = this.location(owner, id);
    if (!input || !Number.isSafeInteger(input.offset) || input.offset < 0
        || !Number.isSafeInteger(input.total) || input.total < 1 || input.total > MAX_IMAGE
        || !SUFFIXES.has(input.suffix) || input.sha256 !== id
        || typeof input.data !== 'string' || !input.data.length
        || input.data.length > MAX_CHUNK / 3 * 4) {
      throw failure('图片分块格式或大小无效');
    }
    const bytes = Buffer.from(input.data, 'base64');
    if (!bytes.length || bytes.length > MAX_CHUNK || bytes.toString('base64') !== input.data
        || input.offset + bytes.length > input.total) {
      throw failure('图片分块数据不完整');
    }
    return locked(directory, async () => {
      let metadata;
      try { metadata = await this.load(directory, id); }
      catch (error) {
        if ((error as any).status !== 404) throw error;
        if (input.offset !== 0) throw failure('图片上传位置不匹配', 409);
        await this.prepare(directory);
        metadata = {id, sha256: id, offset: 0, total: input.total, suffix: input.suffix, complete: false};
        await this.save(directory, metadata);
      }
      if (metadata.total !== input.total || metadata.suffix !== input.suffix || metadata.sha256 !== input.sha256) {
        throw failure('图片上传信息不匹配', 409);
      }
      const file = path.join(directory, 'data');
      const current = metadata.offset ? await readFile(file) : Buffer.alloc(0);
      if (input.offset < metadata.offset) {
        if (input.offset + bytes.length > metadata.offset
            || !current.subarray(input.offset, input.offset + bytes.length).equals(bytes)) {
          throw failure('图片上传分块与已接收内容不一致', 409);
        }
        if (metadata.complete && digest(current) !== id) throw failure('图片内容校验失败', 409);
        return this.response(metadata);
      }
      if (input.offset !== metadata.offset) throw failure('图片上传位置不匹配', 409);
      const nextOffset = metadata.offset + bytes.length;
      if (nextOffset === metadata.total && digest(Buffer.concat([current, bytes])) !== id) {
        throw failure('图片内容校验失败', 409);
      }
      const handle = await open(file, 'a', 0o600);
      try { await handle.chmod(0o600); await handle.writeFile(bytes); await handle.sync(); }
      finally { await handle.close(); }
      metadata = {...metadata, offset: nextOffset, complete: nextOffset === metadata.total};
      await this.save(directory, metadata);
      return this.response(metadata);
    });
  }

  async resolve(owner: any, images: any) {
    if (!Array.isArray(images)) throw failure('图片列表无效');
    return Promise.all(images.map(async image => {
      if (!image || image.uploadId === undefined) return image;
      const directory = this.location(owner, image.uploadId);
      if (image.sha256 !== image.uploadId || !SUFFIXES.has(image.suffix)) {
        throw failure('图片引用信息无效');
      }
      return locked(directory, async () => {
        const metadata = await this.load(directory, image.uploadId);
        if (!metadata.complete || metadata.suffix !== image.suffix) throw failure('图片尚未完整上传', 409);
        const bytes = await readFile(path.join(directory, 'data'));
        if (bytes.length !== metadata.total || digest(bytes) !== image.sha256) throw failure('图片内容校验失败', 409);
        return {suffix: metadata.suffix, data: bytes.toString('base64')};
      });
    }));
  }
}
