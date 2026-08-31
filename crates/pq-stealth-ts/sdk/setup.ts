import type { Host } from '@kohaku-eth/plugins';
import { hexToBytes } from 'viem';
import { snapshotParams } from './config.js';
import type {
  Identity,
  PluginParams,
} from './types.js';
import {
  deriveIdentity,
  ensureWasm,
} from './wasm.js';

export type PluginContext = {
  params: PluginParams;
  account: Identity;
  chainId: bigint;
  keygenMaster: Uint8Array;
  senderMaster?: Uint8Array;
};

/** Validate contracts and derive keys from the host keystore. */
export async function preparePlugin(
  host: Host,
  input: PluginParams,
): Promise<PluginContext> {
  const params = snapshotParams(input);

  await ensureWasm();
  const [chainId, announcerCode, registryCode, keygenKey] = await Promise.all([
    host.provider.getChainId(),
    host.provider.getCode(params.deployment.announcer),
    host.provider.getCode(params.deployment.registry),
    host.keystore.deriveAt(keyPath(params.accountIndex, 0)),
  ]);

  if (announcerCode === '0x') {
    throw new Error(`No ERC-5564 contract at ${params.deployment.announcer}`);
  }

  if (registryCode === '0x') {
    throw new Error(`No ERC-6538 contract at ${params.deployment.registry}`);
  }

  const keygenMaster = hexToBytes(keygenKey);
  const derived = await deriveIdentity(keygenMaster);
  const account: Identity = {
    schemeId: 3,
    keygenIndex: derived.keygenIndex,
    metaAddress: derived.metaAddress,
  };
  const senderMaster = params.mode === 'receive-only'
    ? undefined
    : hexToBytes(await host.keystore.deriveAt(keyPath(params.accountIndex, 1)));

  return { params, account, chainId, keygenMaster, senderMaster };
}

/** Hardened path under m/5564'/60'. Branch 0 is identity, 1 is sender. */
function keyPath(accountIndex: number, branch: number): string {
  return `m/5564'/60'/${accountIndex}'/${branch}'`;
}
