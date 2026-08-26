import type { AssetId, Storage } from '@kohaku-eth/plugins';
import type { Hex, TxRequest } from '@kohaku-eth/provider';
import { PQStealthError } from './errors.js';
import { bindings, ensureInitialized } from './wasm.js';
import type {
  AnnouncementPayload,
  MatchMaterial,
  OperationPart,
  OperationStage,
  PreparedOperation,
  SchemeKind,
  SubmissionAttempt,
} from './types.js';

export type Envelope<T> = {
  schema_version: number;
  value: T;
};

export type IdentityRecord = {
  scheme: SchemeKind;
  scheme_id: number;
  scheme_name: string;
  accepted_j: number;
  meta_address: number[];
};

export type ReservationDraft = {
  id: string;
  chainId: string;
  scheme: SchemeKind;
  index: string;
  metaAddress: Hex;
  payer: Hex;
  asset: StoredAsset;
  amount: string;
  createdAt: number;
};

export type SenderEntropyRecord = {
  scheme: SchemeKind;
  nextIndex: string;
  reservations: ReservationDraft[];
};

export type StoredAsset =
  | { type: 'native' }
  | { type: 'erc20'; contract: Hex }
  | { type: 'erc721'; contract: Hex; tokenId: string };

export type StoredTx = {
  to?: Hex;
  from?: Hex;
  data?: Hex;
  value?: string;
  chainId?: string;
  nonce?: number;
  gas?: string;
  gasLimit?: string;
  gasPrice?: string;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
  type?: 0 | 1 | 2;
  accessList?: Array<{ address: Hex; storageKeys: Hex[] }>;
};

export type StoredAttempt = Omit<SubmissionAttempt, 'submittedAt'> & { submittedAt: number };

export type StoredOperation = {
  id: string;
  kind: 'registration' | 'payment' | 'spend';
  scheme: SchemeKind;
  stage: OperationStage;
  announcement?: AnnouncementPayload;
  transactions: Partial<Record<OperationPart, StoredTx>>;
  attempts: StoredAttempt[];
  announcementBlock?: { number: string; hash: Hex };
  fundingBlock?: { number: string; hash: Hex };
  channelKey?: Hex;
  isChannelOpening?: boolean;
  diagnostics: string[];
  abandoned: boolean;
  createdAt: number;
  spend?: {
    noteId: string;
    material: MatchMaterial;
    signedRaw?: Hex;
    signedHash?: Hex;
  };
};

export type OperationBook = { operations: StoredOperation[] };

export type ChannelRecord = {
  key: Hex;
  metaAddress: Hex;
  status: 'opening' | 'active' | 'abandoned';
  senderBlob: number[];
  opening: StoredOperation;
  memos: StoredOperation[];
};

export type SenderChannelBook = { channels: ChannelRecord[] };

export type StoredNote = {
  id: string;
  eventId: string;
  scheme: SchemeKind;
  address: Hex;
  asset: StoredAsset;
  amount: string;
  spent: boolean;
  blockNumber: string;
  blockHash: Hex;
  transactionHash: Hex;
  logIndex: string;
  announcedMatchesDerived: boolean;
  diagnostics: string[];
  match: MatchMaterial;
};

export type ScannerSnapshot = {
  cursor: { number: string; hash: Hex } | null;
  channelBook: number[][];
  notes: StoredNote[];
  seenEventIds: string[];
};

/** Finalized rollback point and current tentative view are written as one storage value. */
export type ScannerCheckpoint = {
  finalized: ScannerSnapshot;
  current: ScannerSnapshot;
  inactiveChannels: number[][];
  tentative: Array<{ number: string; hash: Hex }>;
};

const storageTails = new WeakMap<object, Promise<void>>();

/** Serialize all plugin instances sharing the exact same host Storage object. */
export async function withStorageLock<T>(storage: Storage, task: () => Promise<T>): Promise<T> {
  const prior = storageTails.get(storage) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const tail = prior.catch(() => undefined).then(() => current);
  storageTails.set(storage, tail);
  await prior.catch(() => undefined);
  try {
    return await task();
  } finally {
    release();
    if (storageTails.get(storage) === tail) storageTails.delete(storage);
  }
}

export async function readRecord<T>(storage: Storage, key: string): Promise<T | null> {
  let raw: string | null;
  try {
    raw = await storage.get(key);
  } catch (error) {
    throw new PQStealthError('StorageFailure', `Could not read ${key}`, error);
  }
  if (raw == null) return null;
  let envelope: Envelope<T>;
  try {
    envelope = JSON.parse(raw) as Envelope<T>;
  } catch (error) {
    throw new PQStealthError('StorageFailure', `Invalid JSON at ${key}`, error);
  }
  await ensureInitialized();
  try {
    bindings.validate_storage_schema(envelope.schema_version);
  } catch (error) {
    throw new PQStealthError(
      'MigrationRequired',
      `Storage schema ${envelope.schema_version} requires migration`,
      error,
    );
  }
  return envelope.value;
}

export async function writeRecord<T>(storage: Storage, key: string, value: T): Promise<void> {
  await ensureInitialized();
  const envelope: Envelope<T> = {
    schema_version: bindings.storage_schema_version(),
    value,
  };
  try {
    await storage.set(key, JSON.stringify(envelope));
  } catch (error) {
    throw new PQStealthError('StorageFailure', `Could not write ${key}`, error);
  }
}

export function storeAsset(asset: AssetId): StoredAsset {
  switch (asset.__type) {
    case 'native': return { type: 'native' };
    case 'erc20': return { type: 'erc20', contract: asset.contract };
    case 'erc721': return { type: 'erc721', contract: asset.contract, tokenId: asset.tokenId.toString() };
  }
}

export function restoreAsset(asset: StoredAsset): AssetId {
  switch (asset.type) {
    case 'native': return { __type: 'native' };
    case 'erc20': return { __type: 'erc20', contract: asset.contract };
    case 'erc721': return { __type: 'erc721', contract: asset.contract, tokenId: BigInt(asset.tokenId) };
  }
}

export function storeTx(tx: TxRequest): StoredTx {
  return {
    ...tx,
    value: tx.value?.toString(),
    chainId: tx.chainId?.toString(),
    gas: tx.gas?.toString(),
    gasLimit: tx.gasLimit?.toString(),
    gasPrice: tx.gasPrice?.toString(),
    maxFeePerGas: tx.maxFeePerGas?.toString(),
    maxPriorityFeePerGas: tx.maxPriorityFeePerGas?.toString(),
  };
}

export function restoreTx(tx: StoredTx): TxRequest {
  return {
    ...tx,
    value: tx.value == null ? undefined : BigInt(tx.value),
    chainId: tx.chainId == null ? undefined : BigInt(tx.chainId),
    gas: tx.gas == null ? undefined : BigInt(tx.gas),
    gasLimit: tx.gasLimit == null ? undefined : BigInt(tx.gasLimit),
    gasPrice: tx.gasPrice == null ? undefined : BigInt(tx.gasPrice),
    maxFeePerGas: tx.maxFeePerGas == null ? undefined : BigInt(tx.maxFeePerGas),
    maxPriorityFeePerGas: tx.maxPriorityFeePerGas == null ? undefined : BigInt(tx.maxPriorityFeePerGas),
  };
}

export function publicOperation(operation: StoredOperation): PreparedOperation {
  return {
    id: operation.id,
    kind: operation.kind,
    scheme: operation.scheme,
    stage: operation.stage,
    announcement: operation.announcement,
    transactions: Object.fromEntries(
      Object.entries(operation.transactions).map(([part, tx]) => [part, restoreTx(tx)]),
    ),
    attempts: operation.attempts.map((attempt) => ({ ...attempt })),
    announcementBlock: operation.announcementBlock && {
      number: BigInt(operation.announcementBlock.number),
      hash: operation.announcementBlock.hash,
    },
    fundingBlock: operation.fundingBlock && {
      number: BigInt(operation.fundingBlock.number),
      hash: operation.fundingBlock.hash,
    },
    channelKey: operation.channelKey,
    isChannelOpening: operation.isChannelOpening,
    diagnostics: [...operation.diagnostics],
    abandoned: operation.abandoned,
    createdAt: operation.createdAt,
  };
}

export function emptySnapshot(): ScannerSnapshot {
  return { cursor: null, channelBook: [], notes: [], seenEventIds: [] };
}

export function emptyCheckpoint(): ScannerCheckpoint {
  const finalized = emptySnapshot();
  return {
    finalized,
    current: { ...finalized, channelBook: [], notes: [], seenEventIds: [] },
    inactiveChannels: [],
    tentative: [],
  };
}
