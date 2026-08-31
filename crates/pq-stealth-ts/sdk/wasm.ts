import initWasm, * as bindings from '../pkg/index.js';
import type { InitInput } from '../pkg/index.js';
import {
  bytesToHex,
  getAddress,
  hexToBytes,
  numberToHex,
  type Address,
  type Hex,
} from 'viem';

let initialization: Promise<void> | undefined;

/** Load the WASM module once. */
export async function ensureWasm(wasmInput?: InitInput): Promise<void> {
  initialization ??= initialize(wasmInput);
  await initialization;
}

async function initialize(wasmInput?: InitInput): Promise<void> {
  if (!wasmInput && typeof process !== 'undefined' && process.versions?.node) {
    const [{ readFile }, { dirname, join }, { fileURLToPath }] = await Promise.all([
      import('node:fs/promises'),
      import('node:path'),
      import('node:url'),
    ]);
    const directory = dirname(fileURLToPath(import.meta.url));

    wasmInput = new Uint8Array(await readFile(join(directory, '../pkg/index_bg.wasm')));
  }

  wasmInput ??= new URL('../pkg/index_bg.wasm', import.meta.url);
  await initWasm({ module_or_path: wasmInput });
}

type RustIdentity = { keygen_index: string; meta_address: number[] };
type RustAnnouncement = {
  stealth_address: number[];
  ephemeral_pubkey: number[];
  metadata: number[];
};
export type Match = { stealth_address: number[]; shared_secret: number[] };

export async function deriveIdentity(keygenMaster: Uint8Array) {
  await ensureWasm();
  const identity = bindings.deriveIdentity(keygenMaster) as RustIdentity;

  return {
    keygenIndex: BigInt(identity.keygen_index),
    metaAddress: bytesToHex(Uint8Array.from(identity.meta_address)),
  };
}

/** Returns undefined when the seed at this index is rejected. */
export function createAnnouncement(
  metaAddress: Hex,
  senderMaster: Uint8Array,
  senderIndex: bigint,
) {
  const announcement = bindings.createAnnouncement(
    hexToBytes(metaAddress),
    senderMaster,
    senderIndex.toString(),
  ) as RustAnnouncement | undefined;

  if (!announcement) return undefined;

  return {
    stealthAddress: bytesToHex(Uint8Array.from(announcement.stealth_address)) as Address,
    ephemeralPublicKey: bytesToHex(Uint8Array.from(announcement.ephemeral_pubkey)),
    metadata: bytesToHex(Uint8Array.from(announcement.metadata)),
  };
}

export function isValidMetaAddress(metaAddress: Hex): boolean {
  return bindings.isValidMetaAddress(hexToBytes(metaAddress));
}

export class Scanner {
  private readonly inner: InstanceType<typeof bindings.Scanner>;

  constructor(keygenMaster: Uint8Array, keygenIndex: bigint, metaAddress: Hex) {
    this.inner = new bindings.Scanner(
      keygenMaster,
      keygenIndex.toString(),
      hexToBytes(metaAddress),
    );
  }

  scan(stealthAddress: Address, ephemeralPublicKey: Hex, metadata: Hex) {
    return this.inner.scan(
      hexToBytes(stealthAddress),
      hexToBytes(ephemeralPublicKey),
      hexToBytes(metadata),
    ) as Match | undefined;
  }

  free(): void {
    this.inner.free();
  }
}

/** Sign an EIP-1559 spend in WASM. */
export async function signSpend(
  keygenMaster: Uint8Array,
  keygenIndex: bigint,
  matched: Match,
  request: {
    chainId: bigint;
    nonce: bigint;
    gasLimit: bigint;
    maxFeePerGas: bigint;
    maxPriorityFeePerGas: bigint;
    to: Address;
    value: bigint;
    data: Hex;
  },
) {
  await ensureWasm();
  const signed = bindings.signSpend(
    keygenMaster,
    keygenIndex.toString(),
    matched,
    {
      chain_id: request.chainId.toString(),
      nonce: request.nonce.toString(),
      gas_limit: request.gasLimit.toString(),
      max_fee_per_gas: request.maxFeePerGas.toString(),
      max_priority_fee_per_gas: request.maxPriorityFeePerGas.toString(),
      to: Array.from(hexToBytes(request.to)),
      value: Array.from(hexToBytes(numberToHex(request.value, { size: 32 }))),
      data: Array.from(hexToBytes(request.data)),
    },
  ) as { raw: number[]; hash: number[]; signer: number[] };

  return {
    rawTransaction: bytesToHex(Uint8Array.from(signed.raw)),
    transactionHash: bytesToHex(Uint8Array.from(signed.hash)),
    signer: getAddress(bytesToHex(Uint8Array.from(signed.signer))),
  };
}
