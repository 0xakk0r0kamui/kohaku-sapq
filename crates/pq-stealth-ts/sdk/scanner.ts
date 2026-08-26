import type { AssetId } from '@kohaku-eth/plugins';
import type { Address, Hex, TxLog } from '@kohaku-eth/provider';
import { loadScannerWorker } from '#scanner-loader';
import type { Remote } from 'comlink';
import type { ScannerWorkerApi, WorkerLog, WorkerMatch } from '../src/scanner-api.js';
import { bindings, byteHex, ensureInitialized, hexBytes } from './wasm.js';
import {
  emptyCheckpoint,
  readRecord,
  restoreAsset,
  storeAsset,
  type IdentityRecord,
  type ScannerCheckpoint,
  type StoredNote,
  withStorageLock,
  writeRecord,
} from './storage.js';
import type { PQStealthNote, SchemeKind } from './types.js';
import type { PQStealthPluginInternal } from './plugin.js';

export class BoundScanner {
  private readonly remote: Remote<ScannerWorkerApi>;
  private readonly closeWorker: () => Promise<void>;
  private closed = false;

  constructor(private readonly plugin: PQStealthPluginInternal) {
    const worker = loadScannerWorker(plugin.params.workerUrl);
    this.remote = worker.remote;
    this.closeWorker = worker.close;
  }

  async scan(): Promise<PQStealthNote[]> {
    if (this.closed) throw new Error('Scanner is closed');
    await ensureInitialized();
    const found: PQStealthNote[] = [];
    for (const scheme of this.plugin.schemes) {
      found.push(...await this.scanScheme(scheme));
    }
    return found;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.closeWorker();
  }

  private async scanScheme(scheme: SchemeKind): Promise<PQStealthNote[]> {
    return withStorageLock(this.plugin.host.storage, async () => {
      const identity = await this.plugin.identity(scheme);
      const key = this.plugin.scannerKey(scheme);
      const stored = await readRecord<ScannerCheckpoint>(this.plugin.host.storage, key);
      const checkpoint = stored && await this.isFinalizedCursorCanonical(stored)
        ? stored
        : emptyCheckpoint();
      const start = checkpoint.finalized.cursor
        ? BigInt(checkpoint.finalized.cursor.number) + 1n
        : this.plugin.params.deployment.announcerStartBlock;
      const latest = await this.plugin.host.provider.getBlockNumber();
      const depth = this.plugin.params.deployment.finalityDepth;
      const finalizedThrough = latest >= depth ? latest - depth : 0n;
      const logs = start <= latest ? await this.fetchCanonicalLogs(start, latest) : [];

      const output = await this.remote.scan({
        scheme,
        identity,
        keygenMaster: Array.from(this.plugin.keygenMaster),
        lookahead: this.plugin.lookahead,
        initialChannelBook: checkpoint.finalized.channelBook,
        finalizedThrough: finalizedThrough.toString(),
        logs: logs.map(workerLog),
      });

      const finalizedNew = output.matches.filter((match) => match.finalized);
      const tentativeNew = output.matches.filter((match) => !match.finalized);
      const refreshedBase = await this.refreshNotes(checkpoint.finalized.notes);
      const finalizedNotes = await this.mergeMatches(refreshedBase, finalizedNew, output.diagnostics);
      const currentNotes = await this.mergeMatches(
        finalizedNotes.map((note) => ({ ...note, diagnostics: [...note.diagnostics] })),
        tentativeNew,
        output.diagnostics,
      );
      const finalizedHeader = finalizedThrough >= this.plugin.params.deployment.announcerStartBlock
        ? await this.plugin.host.provider.getBlockHeader(finalizedThrough)
        : null;
      const latestHeader = await this.plugin.host.provider.getBlockHeader(latest);
      const finalizedSeen = unique([
        ...checkpoint.finalized.seenEventIds,
        ...finalizedNew.map(({ log }) => eventId(log)),
      ]);
      const currentSeen = unique([
        ...finalizedSeen,
        ...tentativeNew.map(({ log }) => eventId(log)),
      ]);
      const next: ScannerCheckpoint = {
        finalized: {
          cursor: finalizedHeader && {
            number: finalizedHeader.number.toString(),
            hash: finalizedHeader.hash,
          },
          channelBook: output.finalizedChannelBook.map((blob) => Array.from(blob)),
          notes: finalizedNotes,
          seenEventIds: finalizedSeen,
        },
        current: {
          cursor: latestHeader && {
            number: latestHeader.number.toString(),
            hash: latestHeader.hash,
          },
          channelBook: output.currentChannelBook.map((blob) => Array.from(blob)),
          notes: currentNotes,
          seenEventIds: currentSeen,
        },
        inactiveChannels: checkpoint.inactiveChannels,
        tentative: uniqueBlocks(logs.filter((log) => log.blockNumber > finalizedThrough)),
      };

      // The full snapshot is the only scanner write: cursor and notes cannot split on failure.
      await writeRecord(this.plugin.host.storage, key, next);
      return [...finalizedNew, ...tentativeNew]
        .flatMap((match) => currentNotes.filter((note) => note.eventId === eventId(match.log)))
        .map(publicNote);
    });
  }

  private async isFinalizedCursorCanonical(checkpoint: ScannerCheckpoint): Promise<boolean> {
    const cursor = checkpoint.finalized.cursor;
    if (!cursor) return true;
    const header = await this.plugin.host.provider.getBlockHeader(BigInt(cursor.number));
    return header?.number === BigInt(cursor.number)
      && header.hash.toLowerCase() === cursor.hash.toLowerCase();
  }

  private async fetchCanonicalLogs(fromBlock: bigint, toBlock: bigint): Promise<TxLog[]> {
    const all: TxLog[] = [];
    const size = BigInt(this.plugin.scanBatchSize);
    const topic = byteHex(bindings.announcement_topic());
    for (let from = fromBlock; from <= toBlock; from += size) {
      const to = from + size - 1n > toBlock ? toBlock : from + size - 1n;
      const logs = await this.plugin.host.provider.getLogs({
        address: this.plugin.announcerAddress,
        fromBlock: from,
        toBlock: to,
        topics: [topic],
      });
      all.push(...logs);
    }
    const deduplicated = new Map<string, TxLog>();
    for (const log of all) {
      if (log.removed) continue;
      deduplicated.set(eventId(log), log);
    }
    const headerCache = new Map<bigint, Awaited<ReturnType<typeof this.plugin.host.provider.getBlockHeader>>>();
    const canonical: TxLog[] = [];
    for (const log of deduplicated.values()) {
      let header = headerCache.get(log.blockNumber);
      if (header === undefined) {
        header = await this.plugin.host.provider.getBlockHeader(log.blockNumber);
        headerCache.set(log.blockNumber, header);
      }
      if (header?.hash === log.blockHash) canonical.push(log);
    }
    return canonical.sort((left, right) =>
      compareBigint(left.blockNumber, right.blockNumber)
      || compareBigint(left.transactionIndex, right.transactionIndex)
      || compareBigint(left.logIndex, right.logIndex));
  }

  private async mergeMatches(
    notes: StoredNote[],
    matches: WorkerMatch[],
    scanDiagnostics: string[],
  ): Promise<StoredNote[]> {
    const known = new Set(notes.map((note) => note.eventId));
    for (const matched of matches) {
      const id = eventId(matched.log);
      if (known.has(id)) continue;
      const discovered = await this.discoverAssets(matched);
      if (discovered.length === 0) {
        discovered.push({ asset: { __type: 'native' }, amount: 0n, diagnostics: [] });
      }
      for (const holding of discovered) {
        notes.push({
          id: `${id}:${assetKey(holding.asset)}`,
          eventId: id,
          scheme: matched.material.scheme,
          address: byteHex(matched.material.stealth_address) as Address,
          asset: storeAsset(holding.asset),
          amount: holding.amount.toString(),
          spent: holding.amount === 0n,
          blockNumber: matched.log.blockNumber,
          blockHash: matched.log.blockHash,
          transactionHash: matched.log.transactionHash,
          logIndex: matched.log.logIndex,
          announcedMatchesDerived: matched.announcedMatchesDerived,
          diagnostics: [...scanDiagnostics, ...holding.diagnostics],
          match: matched.material,
        });
      }
      known.add(id);
    }
    return notes;
  }

  private async discoverAssets(match: WorkerMatch): Promise<Array<{
    asset: AssetId;
    amount: bigint;
    diagnostics: string[];
  }>> {
    const address = byteHex(match.material.stealth_address) as Address;
    const results: Array<{ asset: AssetId; amount: bigint; diagnostics: string[] }> = [{
      asset: { __type: 'native' },
      amount: await this.plugin.host.provider.getBalance(address),
      diagnostics: [],
    }];
    const transferTopic = byteHex(bindings.transfer_topic());
    const indexedAddress = `0x${'0'.repeat(24)}${address.slice(2).toLowerCase()}` as Hex;
    let transfers: TxLog[];
    try {
      const [incoming, outgoing] = await Promise.all([
        this.plugin.host.provider.getLogs({
          fromBlock: this.plugin.params.deployment.announcerStartBlock,
          toBlock: await this.plugin.host.provider.getBlockNumber(),
          topics: [transferTopic, null, indexedAddress],
        }),
        this.plugin.host.provider.getLogs({
          fromBlock: this.plugin.params.deployment.announcerStartBlock,
          toBlock: await this.plugin.host.provider.getBlockNumber(),
          topics: [transferTopic, indexedAddress],
        }),
      ]);
      transfers = [...incoming, ...outgoing];
    } catch (error) {
      results[0]!.diagnostics.push(`Token discovery failed: ${String(error)}`);
      return results;
    }

    const assets = new Map<string, AssetId>();
    for (const log of transfers) {
      if (log.topics.length === 3) {
        const asset: AssetId = { __type: 'erc20', contract: log.address };
        assets.set(assetKey(asset), asset);
      } else if (log.topics.length === 4 && log.topics[3]) {
        const asset: AssetId = {
          __type: 'erc721',
          contract: log.address,
          tokenId: BigInt(log.topics[3]),
        };
        assets.set(assetKey(asset), asset);
      }
    }
    for (const asset of assets.values()) {
      const refreshed = await this.refreshHolding(address, asset);
      if (refreshed.diagnostics.length > 0) {
        results[0]!.diagnostics.push(...refreshed.diagnostics);
      } else {
        results.push(refreshed);
      }
    }
    return results;
  }

  private async refreshNotes(notes: StoredNote[]): Promise<StoredNote[]> {
    const refreshed: StoredNote[] = [];
    for (const note of notes) {
      const value = await this.refreshHolding(note.address, restoreAsset(note.asset));
      refreshed.push({
        ...note,
        amount: value.amount.toString(),
        spent: value.amount === 0n,
        diagnostics: unique([...note.diagnostics, ...value.diagnostics]),
      });
    }
    return refreshed;
  }

  private async refreshHolding(address: Address, asset: AssetId): Promise<{
    asset: AssetId;
    amount: bigint;
    diagnostics: string[];
  }> {
    try {
      if (asset.__type === 'native') {
        return { asset, amount: await this.plugin.host.provider.getBalance(address), diagnostics: [] };
      }
      if (asset.__type === 'erc20') {
        const data = byteHex(bindings.encode_erc20_balance_of(addressBytesUnchecked(address)));
        const response = await this.plugin.host.provider.call({ to: asset.contract, input: data });
        if (!response) throw new Error('empty balanceOf response');
        return {
          asset,
          amount: BigInt(byteHex(bindings.decode_erc20_balance(hexBytes(response)))),
          diagnostics: [],
        };
      }
      const data = byteHex(bindings.encode_erc721_owner_of(
        hexBytes(`0x${asset.tokenId.toString(16).padStart(64, '0')}` as Hex),
      ));
      const response = await this.plugin.host.provider.call({ to: asset.contract, input: data });
      if (!response) throw new Error('empty ownerOf response');
      const owner = byteHex(bindings.decode_erc721_owner(hexBytes(response))).toLowerCase();
      return { asset, amount: owner === address.toLowerCase() ? 1n : 0n, diagnostics: [] };
    } catch (error) {
      return {
        asset,
        amount: 0n,
        diagnostics: [`Skipped malformed/nonstandard token ${asset.__type === 'native' ? '' : asset.contract}: ${String(error)}`],
      };
    }
  }
}

function workerLog(log: TxLog): WorkerLog {
  return {
    ...log,
    blockNumber: log.blockNumber.toString(),
    transactionIndex: log.transactionIndex.toString(),
    logIndex: log.logIndex.toString(),
  };
}

function publicNote(note: StoredNote): PQStealthNote {
  return {
    id: note.id,
    eventId: note.eventId,
    scheme: note.scheme,
    address: note.address,
    asset: restoreAsset(note.asset),
    amount: BigInt(note.amount),
    spent: note.spent,
    blockNumber: BigInt(note.blockNumber),
    blockHash: note.blockHash,
    transactionHash: note.transactionHash,
    logIndex: BigInt(note.logIndex),
    announcedMatchesDerived: note.announcedMatchesDerived,
    diagnostics: [...note.diagnostics],
  };
}

function eventId(log: Pick<TxLog, 'blockHash' | 'transactionHash' | 'logIndex'> | WorkerLog): string {
  return `${log.blockHash}:${log.transactionHash}:${log.logIndex.toString()}`;
}

function compareBigint(left: bigint, right: bigint): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function uniqueBlocks(logs: TxLog[]): Array<{ number: string; hash: Hex }> {
  const values = new Map<string, { number: string; hash: Hex }>();
  for (const log of logs) values.set(`${log.blockNumber}:${log.blockHash}`, {
    number: log.blockNumber.toString(),
    hash: log.blockHash,
  });
  return [...values.values()];
}

function assetKey(asset: AssetId): string {
  switch (asset.__type) {
    case 'native': return 'native';
    case 'erc20': return `erc20:${asset.contract.toLowerCase()}`;
    case 'erc721': return `erc721:${asset.contract.toLowerCase()}:${asset.tokenId}`;
  }
}

function addressBytesUnchecked(address: Address): Uint8Array {
  return hexBytes(address);
}

export { publicNote, assetKey };
