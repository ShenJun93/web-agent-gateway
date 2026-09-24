import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { GatewayAuthority } from '../caller-context.js';
import { sameAuthorityTuple } from '../authority-tuple.js';

export interface BrowserProfileHandle {
  readonly profileId: string;
  readonly owner: GatewayAuthority;
  readonly userDataDir?: string;
}

export interface BrowserProfileStore {
  acquire(profileId: string, owner: GatewayAuthority): Promise<BrowserProfileHandle>;
  release(profile: BrowserProfileHandle, owner: GatewayAuthority): Promise<void>;
}

interface OwnerRecord {
  readonly version: 1;
  readonly profileId: string;
  readonly owner: GatewayAuthority;
  readonly createdAt: number;
}

const PROFILE_ID = /^[A-Za-z0-9._:-]{1,128}$/;

function assertProfileId(profileId: string): void {
  if (!PROFILE_ID.test(profileId)) throw new Error('Browser profile id is invalid');
}

function cloneOwner(owner: GatewayAuthority): GatewayAuthority {
  return Object.freeze({ ...owner });
}

function sameProfileOwner(record: OwnerRecord, profileId: string, owner: GatewayAuthority): boolean {
  return record.version === 1
    && record.profileId === profileId
    && sameAuthorityTuple(record.owner, owner);
}

function parseOwnerRecord(text: string): OwnerRecord {
  const value = JSON.parse(text) as Partial<OwnerRecord>;
  if (value.version !== 1 || typeof value.profileId !== 'string'
      || typeof value.createdAt !== 'number' || typeof value.owner !== 'object' || value.owner === null) {
    throw new Error('Browser profile OWNER.json is invalid');
  }
  const owner = value.owner as Partial<GatewayAuthority>;
  if (typeof owner.ownerId !== 'string' || typeof owner.sessionId !== 'string' || typeof owner.adapterId !== 'string') {
    throw new Error('Browser profile OWNER.json authority is invalid');
  }
  return {
    version: 1,
    profileId: value.profileId,
    owner: {
      ownerId: owner.ownerId,
      sessionId: owner.sessionId,
      adapterId: owner.adapterId,
    },
    createdAt: value.createdAt,
  };
}

export function createMemoryBrowserProfileStore(): BrowserProfileStore {
  const owners = new Map<string, GatewayAuthority>();
  const active = new Set<string>();
  return {
    async acquire(profileId, owner) {
      assertProfileId(profileId);
      const existing = owners.get(profileId);
      if (existing && !sameAuthorityTuple(existing, owner)) {
        throw new Error('Browser profile is permanently owned by another authority');
      }
      if (active.has(profileId)) throw new Error('Browser profile is already active');
      if (!existing) owners.set(profileId, cloneOwner(owner));
      active.add(profileId);
      return Object.freeze({ profileId, owner: cloneOwner(owner) });
    },
    async release(profile, owner) {
      const existing = owners.get(profile.profileId);
      if (!existing || !sameAuthorityTuple(existing, owner) || !sameAuthorityTuple(profile.owner, owner)) {
        throw new Error('Browser profile release authority mismatch');
      }
      if (!active.delete(profile.profileId)) throw new Error('Browser profile is not active');
    },
  };
}

export function createFileBrowserProfileStore(options: {
  root: string;
  now?: () => number;
}): BrowserProfileStore {
  const now = options.now ?? Date.now;
  const active = new Set<string>();
  let resolvedRoot: Promise<string> | undefined;

  async function root(): Promise<string> {
    if (!resolvedRoot) {
      resolvedRoot = (async () => {
        await mkdir(options.root, { recursive: true });
        return realpath(options.root);
      })();
    }
    return resolvedRoot;
  }

  return {
    async acquire(profileId, owner) {
      assertProfileId(profileId);
      if (active.has(profileId)) throw new Error('Browser profile is already active');
      const profileRoot = resolve(await root(), profileId);
      const expectedPrefix = `${await root()}\\`;
      if (process.platform === 'win32') {
        if (!profileRoot.toLowerCase().startsWith(expectedPrefix.toLowerCase())) {
          throw new Error('Browser profile escapes configured root');
        }
      } else if (!profileRoot.startsWith(`${await root()}/`)) {
        throw new Error('Browser profile escapes configured root');
      }

      let created = false;
      try {
        await mkdir(profileRoot);
        created = true;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'EEXIST') throw error;
      }

      const ownerPath = resolve(profileRoot, 'OWNER.json');
      if (created) {
        const record: OwnerRecord = {
          version: 1,
          profileId,
          owner: cloneOwner(owner),
          createdAt: now(),
        };
        await writeFile(ownerPath, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
      } else {
        const existing = parseOwnerRecord(await readFile(ownerPath, 'utf8'));
        if (!sameProfileOwner(existing, profileId, owner)) {
          throw new Error('Browser profile is permanently owned by another authority');
        }
      }

      active.add(profileId);
      return Object.freeze({
        profileId,
        owner: cloneOwner(owner),
        userDataDir: profileRoot,
      });
    },

    async release(profile, owner) {
      if (!sameAuthorityTuple(profile.owner, owner)) throw new Error('Browser profile release authority mismatch');
      if (!active.delete(profile.profileId)) throw new Error('Browser profile is not active');
    },
  };
}
