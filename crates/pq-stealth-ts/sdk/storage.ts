import type { Storage } from '@kohaku-eth/plugins';
import type { Address, Hex } from 'viem';

export type StoredAsset =
  | { type: 'native' }
  | { type: 'erc20'; contract: Address };

export type StoredHolding = {
  asset: StoredAsset;
  amount: string;
  spent: boolean;
};

export type StoredMatch = {
  announcementId: Hex;
  address: Address;
  sharedSecret: Hex;
  blockNumber: string;
  holdings: StoredHolding[];
};

export type ScanState = {
  nextBlock: string;
  matches: StoredMatch[];
};

export type SenderState = {
  nextIndex: string;
};

const SCHEMA_VERSION = 1;
const locks = new WeakMap<Storage, Promise<void>>();

export async function readRecord<T>(storage: Storage, key: string): Promise<T | undefined> {
  const encoded = await storage.get(key);

  if (encoded === null) return undefined;

  const record = JSON.parse(encoded) as { schemaVersion?: unknown; value?: T };

  if (record.schemaVersion !== SCHEMA_VERSION || !('value' in record)) {
    throw new Error(`Unsupported or malformed storage record: ${key}`);
  }

  return record.value;
}

export async function writeRecord<T>(storage: Storage, key: string, value: T): Promise<void> {
  await storage.set(key, JSON.stringify({ schemaVersion: SCHEMA_VERSION, value }));
}

/** Run tasks on this Storage one at a time. */
export async function withStorageLock<T>(storage: Storage, task: () => Promise<T>): Promise<T> {
  const previous = locks.get(storage) ?? Promise.resolve();
  let release = () => {};
  const current = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.catch(() => {}).then(() => current);

  locks.set(storage, queued);
  await previous.catch(() => {});

  try {
    return await task();
  } finally {
    release();

    if (locks.get(storage) === queued) locks.delete(storage);
  }
}
