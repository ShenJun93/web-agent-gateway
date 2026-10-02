import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';
import type { GatewayAuthority } from '../caller-context.js';
import { sameAuthorityTuple } from '../authority-tuple.js';

export interface ArtifactHandle {
  readonly artifactId: string;
  readonly owner: GatewayAuthority;
  readonly filename: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly createdAt: number;
  readonly internalPath: string;
}

export interface ArtifactRead {
  readonly artifact: ArtifactHandle;
  readonly bytes: Uint8Array;
}

interface ArtifactMeta {
  readonly version: 1;
  readonly artifactId: string;
  readonly owner: GatewayAuthority;
  readonly filename: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly createdAt: number;
}

const ARTIFACT_ID = /^artifact_[0-9a-f-]{36}$/;
const MAX_DEFAULT_BYTES = 32 * 1024 * 1024;

function safeFilename(input: string): string {
  const name = basename(input)
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
    .replace(/[. ]+$/g, '')
    .slice(0, 180);
  return name === '' ? 'artifact.bin' : name;
}

function handle(meta: ArtifactMeta, root: string): ArtifactHandle {
  return Object.freeze({
    artifactId: meta.artifactId,
    owner: Object.freeze({ ...meta.owner }),
    filename: meta.filename,
    sizeBytes: meta.sizeBytes,
    sha256: meta.sha256,
    createdAt: meta.createdAt,
    internalPath: join(root, meta.artifactId, meta.filename),
  });
}

export class ArtifactPort {
  readonly #rootInput: string;
  readonly #authorizeSource: (owner: GatewayAuthority, requestedPath: string) => Promise<string>;
  readonly #now: () => number;
  readonly #uuid: () => string;
  readonly #maxBytes: number;
  #root?: Promise<string>;

  constructor(options: {
    root: string;
    authorizeSource(owner: GatewayAuthority, requestedPath: string): Promise<string>;
    now?: () => number;
    randomUUID?: () => string;
    maxBytes?: number;
  }) {
    if (!isAbsolute(options.root)) throw new Error('ArtifactPort root must be absolute');
    this.#rootInput = options.root;
    this.#authorizeSource = options.authorizeSource;
    this.#now = options.now ?? Date.now;
    this.#uuid = options.randomUUID ?? randomUUID;
    this.#maxBytes = options.maxBytes ?? MAX_DEFAULT_BYTES;
    if (!Number.isInteger(this.#maxBytes) || this.#maxBytes < 1 || this.#maxBytes > 256 * 1024 * 1024) {
      throw new Error('ArtifactPort maxBytes is invalid');
    }
  }

  async importFile(owner: GatewayAuthority, requestedPath: string): Promise<ArtifactHandle> {
    const approved = await this.#authorizeSource(owner, requestedPath);
    if (!isAbsolute(approved)) throw new Error('ArtifactPort source authorization returned a non-absolute path');
    const source = await realpath(approved);
    const info = await stat(source);
    if (!info.isFile()) throw new Error('ArtifactPort source is not a file');
    if (info.size > this.#maxBytes) throw new Error('ArtifactPort source exceeds size limit');
    const bytes = await readFile(source);
    if (bytes.length > this.#maxBytes) throw new Error('ArtifactPort source exceeds size limit');
    return this.#persistBytes(owner, safeFilename(source), bytes);
  }

  async createBytes(
    owner: GatewayAuthority,
    filename: string,
    bytesInput: Uint8Array,
  ): Promise<ArtifactHandle> {
    if (!(bytesInput instanceof Uint8Array)) throw new Error('ArtifactPort bytes are invalid');
    const bytes = Buffer.from(bytesInput);
    if (bytes.length > this.#maxBytes) throw new Error('ArtifactPort bytes exceed size limit');
    return this.#persistBytes(owner, safeFilename(filename), bytes);
  }

  async readBytes(owner: GatewayAuthority, artifactId: string): Promise<ArtifactRead> {
    const root = await this.#rootPath();
    const meta = await this.#readMeta(root, artifactId);
    if (!sameAuthorityTuple(meta.owner, owner)) throw new Error('ArtifactPort artifact is owned by another authority');
    const payload = resolve(root, artifactId, meta.filename);
    const bytes = await readFile(payload);
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (bytes.length !== meta.sizeBytes || digest !== meta.sha256) {
      throw new Error('ArtifactPort artifact content diverged from manifest');
    }
    return Object.freeze({ artifact: handle(meta, root), bytes: Uint8Array.from(bytes) });
  }

  async get(owner: GatewayAuthority, artifactId: string): Promise<ArtifactHandle> {
    return (await this.readBytes(owner, artifactId)).artifact;
  }

  async list(owner: GatewayAuthority): Promise<readonly ArtifactHandle[]> {
    const root = await this.#rootPath();
    const entries = await readdir(root, { withFileTypes: true });
    const output: ArtifactHandle[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !ARTIFACT_ID.test(entry.name)) continue;
      try {
        const meta = await this.#readMeta(root, entry.name);
        if (sameAuthorityTuple(meta.owner, owner)) output.push(handle(meta, root));
      } catch {
        // Corrupt/unrelated artifact directories are not adopted implicitly.
      }
    }
    return Object.freeze(output);
  }

  async remove(owner: GatewayAuthority, artifactId: string): Promise<void> {
    const artifact = await this.get(owner, artifactId);
    await rm(resolve(await this.#rootPath(), artifact.artifactId), { recursive: true, force: false });
  }

  async #persistBytes(
    owner: GatewayAuthority,
    filename: string,
    bytes: Uint8Array,
  ): Promise<ArtifactHandle> {
    if (bytes.length > this.#maxBytes) throw new Error('ArtifactPort bytes exceed size limit');
    const artifactId = `artifact_${this.#uuid()}`;
    if (!ARTIFACT_ID.test(artifactId)) throw new Error('ArtifactPort generated invalid artifact id');
    const root = await this.#rootPath();
    const artifactRoot = resolve(root, artifactId);
    await mkdir(artifactRoot);
    const payload = resolve(artifactRoot, filename);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const createdAt = this.#now();
    const meta: ArtifactMeta = {
      version: 1,
      artifactId,
      owner: Object.freeze({ ...owner }),
      filename,
      sizeBytes: bytes.length,
      sha256,
      createdAt,
    };

    try {
      await writeFile(payload, bytes, { flag: 'wx' });
      await writeFile(resolve(artifactRoot, 'META.json'), `${JSON.stringify(meta, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
      });
    } catch (error) {
      await rm(artifactRoot, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
    return handle(meta, root);
  }

  async #rootPath(): Promise<string> {
    if (!this.#root) {
      this.#root = (async () => {
        await mkdir(this.#rootInput, { recursive: true });
        return realpath(this.#rootInput);
      })();
    }
    return this.#root;
  }

  async #readMeta(root: string, artifactId: string): Promise<ArtifactMeta> {
    if (!ARTIFACT_ID.test(artifactId)) throw new Error('ArtifactPort artifact id is invalid');
    const artifactRoot = resolve(root, artifactId);
    const text = await readFile(resolve(artifactRoot, 'META.json'), 'utf8');
    const value = JSON.parse(text) as Partial<ArtifactMeta>;
    if (value.version !== 1 || value.artifactId !== artifactId
        || typeof value.filename !== 'string' || safeFilename(value.filename) !== value.filename
        || typeof value.sizeBytes !== 'number' || !Number.isInteger(value.sizeBytes) || value.sizeBytes < 0
        || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)
        || typeof value.createdAt !== 'number'
        || typeof value.owner !== 'object' || value.owner === null) {
      throw new Error('ArtifactPort manifest is invalid');
    }
    const owner = value.owner as Partial<GatewayAuthority>;
    if (typeof owner.ownerId !== 'string' || typeof owner.sessionId !== 'string' || typeof owner.adapterId !== 'string') {
      throw new Error('ArtifactPort manifest authority is invalid');
    }
    return {
      version: 1,
      artifactId,
      filename: value.filename,
      sizeBytes: value.sizeBytes,
      sha256: value.sha256,
      createdAt: value.createdAt,
      owner: { ownerId: owner.ownerId, sessionId: owner.sessionId, adapterId: owner.adapterId },
    };
  }
}
