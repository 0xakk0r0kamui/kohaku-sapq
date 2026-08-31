import {
  getAddress,
  hexToBytes,
  isAddress,
  type Hex,
} from 'viem';
import { assetKey } from './assets.js';
import {
  DEFAULT_FINALITY_DEPTH,
  DEFAULT_RESCAN_BLOCKS,
  DEFAULT_SCAN_BATCH_SIZE,
} from './scanner.js';
import type { Asset, PluginParams } from './types.js';
import { isValidMetaAddress } from './wasm.js';

/** Validate params and return a frozen copy. */
export function snapshotParams(params: PluginParams): PluginParams {
  validateParams(params);
  const assets: Asset[] = params.assets.map((asset) => asset.__type === 'native'
    ? { __type: 'native' }
    : { __type: 'erc20', contract: getAddress(asset.contract) });

  return Object.freeze({
    accountIndex: params.accountIndex,
    mode: params.mode,
    assets: Object.freeze(assets),
    deployment: Object.freeze({
      ...params.deployment,
      announcer: getAddress(params.deployment.announcer),
      registry: getAddress(params.deployment.registry),
    }),
  });
}

export function validateAsset(asset: Asset): void {
  if (asset.__type === 'native') return;

  if (asset.__type === 'erc20') {
    if (!isAddress(asset.contract)) throw new Error('ERC-20 contract address is invalid');

    return;
  }

  throw new Error('Unsupported asset type');
}

export function validateMetaAddress(metaAddress: Hex): void {
  if (hexToBytes(metaAddress).length !== 1_250 || !isValidMetaAddress(metaAddress)) {
    throw new Error('Invalid scheme 3 meta-address');
  }
}

export function validateAmount(amount: bigint): void {
  if (amount <= 0n || amount >= (1n << 256n)) {
    throw new Error('Amount must fit uint256 and be greater than zero');
  }
}

function validateParams(params: PluginParams): void {
  if (!['create', 'resume', 'receive-only'].includes(params.mode)) {
    throw new Error('Operational mode is invalid');
  }

  if (!Number.isSafeInteger(params.accountIndex)
    || params.accountIndex < 0
    || params.accountIndex > 0x7fff_ffff) {
    throw new Error('accountIndex must fit a hardened BIP-32 child index');
  }

  if (!isAddress(params.deployment.announcer) || !isAddress(params.deployment.registry)) {
    throw new Error('Deployment addresses are invalid');
  }

  for (const value of [
    params.deployment.announcerStartBlock,
    params.deployment.finalityDepth ?? DEFAULT_FINALITY_DEPTH,
    params.deployment.rescanBlocks ?? DEFAULT_RESCAN_BLOCKS,
  ]) {
    if (value < 0n) throw new Error('Block configuration cannot be negative');
  }

  const batch = params.deployment.scanBatchSize ?? DEFAULT_SCAN_BATCH_SIZE;

  if (batch < 1n) throw new Error('scanBatchSize must be positive');

  if (params.assets.length === 0) throw new Error('At least one tracked asset is required');

  params.assets.forEach(validateAsset);
  const keys = params.assets.map(assetKey);

  if (new Set(keys).size !== keys.length) throw new Error('Tracked assets must be unique');
}
