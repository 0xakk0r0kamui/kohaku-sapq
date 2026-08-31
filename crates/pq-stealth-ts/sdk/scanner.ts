import type { Host } from '@kohaku-eth/plugins';
import type { TxLog } from '@kohaku-eth/provider';
import {
  bytesToHex,
  concatHex,
  getAddress,
  isAddress,
  isHex,
  keccak256,
  numberToHex,
  type Hex,
} from 'viem';
import {
  assetBalance,
  publicNotes,
  sameStoredAsset,
  storeAsset,
} from './assets.js';
import { ANNOUNCEMENT_TOPIC, decodeAnnouncement } from './abi.js';
import {
  readRecord,
  withStorageLock,
  writeRecord,
  type ScanState,
  type StoredHolding,
  type StoredMatch,
} from './storage.js';
import type {
  Identity,
  Note,
  PluginParams,
} from './types.js';
import { Scanner } from './wasm.js';

export const DEFAULT_FINALITY_DEPTH = 12n;
export const DEFAULT_SCAN_BATCH_SIZE = 2_000n;
export const DEFAULT_RESCAN_BLOCKS = 12n;

/** Update stored matches from announcer logs and return notes. */
export async function scanNotes(
  host: Host,
  params: PluginParams,
  identity: Identity,
  keygenMaster: Uint8Array,
  storageKey: string,
): Promise<Note[]> {
  return withStorageLock(host.storage, async () => {
    const state = await readRecord<ScanState>(host.storage, storageKey) ?? {
      nextBlock: params.deployment.announcerStartBlock.toString(),
      matches: [],
    };

    await updateScanState(host, params, identity, keygenMaster, state);
    await writeRecord(host.storage, storageKey, state);

    return publicNotes(state);
  });
}

/** Scan logs and refresh balances. */
export async function updateScanState(
  host: Host,
  params: PluginParams,
  identity: Identity,
  keygenMaster: Uint8Array,
  state: ScanState,
): Promise<void> {
  const scanner = new Scanner(keygenMaster, identity.keygenIndex, identity.metaAddress);

  try {
    await scanAnnouncements(host, params, scanner, state);
  } finally {
    scanner.free();
  }

  await refreshHoldings(host, params, state);
}

/** Read announcer logs from the stored cursor, applying finality and a rescan window. */
async function scanAnnouncements(
  host: Host,
  params: PluginParams,
  scanner: Scanner,
  state: ScanState,
): Promise<void> {
  const latest = await host.provider.getBlockNumber();
  const finalityDepth = params.deployment.finalityDepth ?? DEFAULT_FINALITY_DEPTH;

  if (latest < finalityDepth) return;

  const end = latest - finalityDepth;
  const startBlock = params.deployment.announcerStartBlock;
  const rescanBlocks = params.deployment.rescanBlocks ?? DEFAULT_RESCAN_BLOCKS;
  const cursor = min(BigInt(state.nextBlock), end + 1n);
  const from = max(startBlock, cursor > rescanBlocks ? cursor - rescanBlocks : startBlock);

  if (from > end) return;

  const retained = state.matches.filter((match) => BigInt(match.blockNumber) < from);
  const matches = new Map(retained.map((match) => [match.announcementId, match]));
  const batchSize = params.deployment.scanBatchSize ?? DEFAULT_SCAN_BATCH_SIZE;

  for (let batchStart = from; batchStart <= end; batchStart += batchSize) {
    const batchEnd = min(end, batchStart + batchSize - 1n);
    const logs = await host.provider.getLogs({
      address: params.deployment.announcer,
      fromBlock: batchStart,
      toBlock: batchEnd,
      topics: [ANNOUNCEMENT_TOPIC, numberToHex(3n, { size: 32 })],
    });

    for (const log of logs) {
      const found = scanLog(scanner, log);

      if (!found) continue;

      const prior = matches.get(found.announcementId);

      matches.set(found.announcementId, { ...found, holdings: prior?.holdings ?? [] });
    }
  }
  state.matches = [...matches.values()];
  state.nextBlock = (end + 1n).toString();
}

/** Refresh ETH and ERC-20 balances on each stored match. */
async function refreshHoldings(
  host: Host,
  params: PluginParams,
  state: ScanState,
): Promise<void> {
  for (const match of state.matches) {
    const next: StoredHolding[] = [];

    for (const asset of params.assets) {
      const stored = storeAsset(asset);
      const amount = await assetBalance(host, asset, match.address);
      const previous = match.holdings.find((holding) => sameStoredAsset(holding.asset, stored));

      if (amount > 0n) {
        next.push({ asset: stored, amount: amount.toString(), spent: false });
      } else if (previous && BigInt(previous.amount) > 0n) {
        next.push({ ...previous, spent: true });
      }
    }
    match.holdings = next;
  }
}

/** Match one Announcement log. */
function scanLog(scanner: Scanner, log: TxLog): StoredMatch | undefined {
  try {
    if (!isAddress(log.address)
      || !isHexString(log.data)
      || !log.topics.every(isHexString)) return undefined;

    const event = decodeAnnouncement(log.data, log.topics);

    if (event.schemeId !== 3n) return undefined;

    const matched = scanner.scan(
      event.stealthAddress,
      event.ephemeralPublicKey,
      event.metadata,
    );

    if (!matched) return undefined;

    const address = getAddress(bytesToHex(Uint8Array.from(matched.stealth_address)));

    if (address.toLowerCase() !== event.stealthAddress.toLowerCase()) return undefined;

    return {
      announcementId: keccak256(concatHex([
        numberToHex(log.blockNumber, { size: 32 }),
        log.address,
        ...log.topics,
        log.data,
      ])),
      address,
      sharedSecret: bytesToHex(Uint8Array.from(matched.shared_secret)),
      blockNumber: log.blockNumber.toString(),
      holdings: [],
    };
  } catch {
    return undefined;
  }
}

function isHexString(value: string): value is Hex {
  return isHex(value, { strict: true });
}

function min(left: bigint, right: bigint): bigint {
  return left < right ? left : right;
}

function max(left: bigint, right: bigint): bigint {
  return left > right ? left : right;
}
