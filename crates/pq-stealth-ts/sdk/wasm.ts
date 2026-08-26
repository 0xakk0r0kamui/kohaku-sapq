import initWasm, * as bindings from '../pkg/index.js';
import { bytesToHex, hexToBytes, numberToHex } from 'viem';
import type { AssetId } from '@kohaku-eth/plugins';
import type { Address, Hex, TransactionReceipt, TxRequest } from '@kohaku-eth/provider';
import type {
  AnnouncementPayload,
  MatchMaterial,
  SchemeKind,
} from './types.js';
import type { IdentityRecord } from './storage.js';

let initPromise: Promise<void> | null = null;

export async function ensureInitialized(wasmInput?: BufferSource | Response): Promise<void> {
  if (!initPromise) initPromise = initialize(wasmInput);
  await initPromise;
}

async function initialize(wasmInput?: BufferSource | Response): Promise<void> {
  if (!wasmInput && typeof process !== 'undefined' && process.versions?.node) {
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const directory = dirname(fileURLToPath(import.meta.url));
    wasmInput = new Uint8Array(await readFile(join(directory, '../pkg/index_bg.wasm')));
  }
  await initWasm(wasmInput === undefined ? undefined : { module_or_path: wasmInput });
}

export { bindings };

export function hexBytes(value: Hex): Uint8Array {
  return hexToBytes(value);
}

export function byteHex(value: ArrayLike<number>): Hex {
  return bytesToHex(Uint8Array.from(value));
}

export function addressBytes(value: Address): Uint8Array {
  const bytes = hexBytes(value);
  if (bytes.length !== 20) throw new Error(`Expected a 20-byte address, got ${bytes.length}`);
  return bytes;
}

export function amountBytes(value: bigint): Uint8Array {
  if (value < 0n) throw new Error('Amount cannot be negative');
  return hexBytes(numberToHex(value, { size: 32 }));
}

export async function deriveIdentity(
  scheme: SchemeKind,
  keygenMaster: Uint8Array,
): Promise<IdentityRecord> {
  await ensureInitialized();
  return bindings.create_identity(scheme, keygenMaster) as IdentityRecord;
}

function rustAsset(asset: AssetId) {
  switch (asset.__type) {
    case 'native': return { type: 'native' };
    case 'erc20': return { type: 'erc20', contract: Array.from(addressBytes(asset.contract)) };
    case 'erc721': return {
      type: 'erc721',
      contract: Array.from(addressBytes(asset.contract)),
      token_id: Array.from(amountBytes(asset.tokenId)),
    };
  }
}

type RustIntent = { to: number[]; value: number[]; data: number[] };

export async function buildAssetTransfer(
  asset: AssetId,
  from: Address,
  to: Address,
  amount: bigint,
  spend: boolean,
): Promise<TxRequest> {
  await ensureInitialized();
  const intent = bindings.build_asset_transfer(
    rustAsset(asset),
    addressBytes(from),
    addressBytes(to),
    amountBytes(amount),
    spend,
  ) as RustIntent;
  return {
    to: byteHex(intent.to) as Address,
    value: BigInt(byteHex(intent.value)),
    data: byteHex(intent.data),
  };
}

export async function encodeAnnouncement(payload: AnnouncementPayload): Promise<Hex> {
  await ensureInitialized();
  return byteHex(bindings.encode_announce_call(payload));
}

export async function verifyAssetTransferReceipt(
  tx: TxRequest,
  receipt: TransactionReceipt,
): Promise<boolean> {
  await ensureInitialized();
  if (!tx.from || !tx.to) throw new Error('Asset receipt verification requires from and to');
  return bindings.verify_asset_transfer_receipt(
    addressBytes(tx.from),
    {
      to: Array.from(addressBytes(tx.to)),
      value: Array.from(amountBytes(tx.value ?? 0n)),
      data: Array.from(hexBytes(tx.data ?? '0x')),
    },
    receipt.logs.map((log) => ({
      address: Array.from(addressBytes(log.address)),
      topics: log.topics.map((topic) => Array.from(hexBytes(topic))),
      data: Array.from(hexBytes(log.data)),
    })),
  );
}

export async function signSpend(
  keygenMaster: Uint8Array,
  acceptedJ: number,
  material: MatchMaterial,
  tx: Required<Pick<TxRequest,
    'chainId' | 'nonce' | 'gasLimit' | 'maxFeePerGas' | 'maxPriorityFeePerGas' | 'to' | 'value' | 'data'>>,
): Promise<{ raw: Hex; hash: Hex; signer: Address }> {
  await ensureInitialized();
  const result = bindings.sign_prepared_spend(
    keygenMaster,
    acceptedJ.toString(),
    material,
    {
      chain_id: tx.chainId.toString(),
      nonce: tx.nonce.toString(),
      gas_limit: tx.gasLimit.toString(),
      max_fee_per_gas: tx.maxFeePerGas.toString(),
      max_priority_fee_per_gas: tx.maxPriorityFeePerGas.toString(),
      intent: {
        to: Array.from(addressBytes(tx.to)),
        value: Array.from(amountBytes(tx.value)),
        data: Array.from(hexBytes(tx.data)),
      },
    },
  ) as { raw: number[]; hash: number[]; signer: number[] };
  return {
    raw: byteHex(result.raw),
    hash: byteHex(result.hash),
    signer: byteHex(result.signer) as Address,
  };
}
