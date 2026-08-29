import { ensureInitialized, bindings, addressBytes, hexBytes } from '../sdk/wasm.js';
import type { Hex } from '@kohaku-eth/provider';
import type { IdentityRecord } from '../sdk/storage.js';
import type { MatchMaterial, SchemeKind } from '../sdk/types.js';

export type WorkerLog = {
  blockNumber: string;
  blockHash: Hex;
  transactionHash: Hex;
  transactionIndex: string;
  logIndex: string;
  removed: boolean;
  address: Hex;
  topics: Hex[];
  data: Hex;
};

export type WorkerScanRequest = {
  scheme: SchemeKind;
  identity: IdentityRecord;
  keygenMaster: number[];
  lookahead: number;
  initialChannelBook: number[][];
  finalizedThrough: string;
  logs: WorkerLog[];
};

export type WorkerMatch = {
  log: WorkerLog;
  material: MatchMaterial;
  announcedMatchesDerived: boolean;
  finalized: boolean;
};

export type WorkerScanOutput = {
  matches: WorkerMatch[];
  finalizedChannelBook: number[][];
  currentChannelBook: number[][];
  diagnostics: string[];
};

type DecodedLog = {
  scheme_id: number;
  stealth_address: number[];
  ephemeral_pubkey: number[];
  metadata: number[];
};

type ScanResult = {
  material: MatchMaterial;
  announced_matches_derived: boolean;
} | undefined;

export const scannerWorkerApi = {
  async scan(request: WorkerScanRequest): Promise<WorkerScanOutput> {
    await ensureInitialized();
    const finalizedThrough = BigInt(request.finalizedThrough);
    let channels = request.initialChannelBook.map((blob) => [...blob]);
    let finalizedChannels = channels.map((blob) => [...blob]);
    const matches: WorkerMatch[] = [];
    const diagnostics: string[] = [];

    for (const log of request.logs) {
      let decoded: DecodedLog;
      try {
        decoded = bindings.decode_announcement_log(
          addressBytes(log.address),
          log.topics.map((topic) => Array.from(hexBytes(topic))),
          hexBytes(log.data),
        ) as DecodedLog;
      } catch (error) {
        diagnostics.push(`Skipped malformed ERC-5564 log ${eventId(log)}: ${String(error)}`);
        continue;
      }

      
      if (decoded.scheme_id !== request.identity.scheme_id) continue;
      const wire = {
        scheme: request.scheme,
        scheme_id: decoded.scheme_id,
        stealth_address: Array.from(decoded.stealth_address),
        ephemeral_pubkey: Array.from(decoded.ephemeral_pubkey),
        metadata: Array.from(decoded.metadata),
      };

      let matched: ScanResult;
      if (request.scheme.endsWith('-channel')) {
        const output = bindings.scan_channel(
          request.scheme,
          Uint8Array.from(request.keygenMaster),
          request.identity.accepted_j.toString(),
          Uint8Array.from(request.identity.meta_address),
          wire,
          channels,
          request.lookahead,
        ) as { matched?: ScanResult; channel_blobs: number[][] };
        channels = output.channel_blobs.map((blob) => Array.from(blob));
        matched = output.matched;
      } else {
        matched = bindings.scan_payment(
          request.scheme,
          Uint8Array.from(request.keygenMaster),
          request.identity.accepted_j.toString(),
          Uint8Array.from(request.identity.meta_address),
          wire,
        ) as ScanResult;
      }

      if (matched) {
        matches.push({
          log,
          material: normalizeMaterial(matched.material),
          announcedMatchesDerived: matched.announced_matches_derived,
          finalized: BigInt(log.blockNumber) <= finalizedThrough,
        });
      }
      if (BigInt(log.blockNumber) <= finalizedThrough) {
        finalizedChannels = channels.map((blob) => [...blob]);
      }
    }

    return {
      matches,
      finalizedChannelBook: finalizedChannels,
      currentChannelBook: channels,
      diagnostics,
    };
  },
};

function normalizeMaterial(material: MatchMaterial): MatchMaterial {
  return {
    ...material,
    stealth_address: Array.from(material.stealth_address),
    shared_secret: Array.from(material.shared_secret),
    channel_key: material.channel_key == null ? material.channel_key : Array.from(material.channel_key),
  };
}

function eventId(log: WorkerLog): string {
  return `${log.blockHash}:${log.transactionHash}:${log.logIndex}`;
}

export type ScannerWorkerApi = typeof scannerWorkerApi;
