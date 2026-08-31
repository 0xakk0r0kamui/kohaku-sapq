import type { Host } from '@kohaku-eth/plugins';
import type { TxData } from '@kohaku-eth/provider';
import {
  bytesToHex,
  concatHex,
  getAddress,
  keccak256,
  type Address,
  type Hex,
} from 'viem';
import {
  decodeErc20Balance,
  encodeErc20Balance,
  encodeErc20Transfer,
} from './abi.js';
import type {
  ScanState,
  StoredAsset,
  StoredHolding,
  StoredMatch,
} from './storage.js';
import type { Asset, Note } from './types.js';

export function assetKey(asset: Asset): string {
  return asset.__type === 'native' ? 'native' : `erc20:${asset.contract.toLowerCase()}`;
}

export function sameAsset(left: Asset, right: Asset): boolean {
  return assetKey(left) === assetKey(right);
}

export function storeAsset(asset: Asset): StoredAsset {
  return asset.__type === 'native'
    ? { type: 'native' }
    : { type: 'erc20', contract: getAddress(asset.contract) };
}

export function restoreAsset(asset: StoredAsset): Asset {
  return asset.type === 'native'
    ? { __type: 'native' }
    : { __type: 'erc20', contract: asset.contract };
}

export function assetTransfer(
  asset: Asset,
  recipient: Address,
  amount: bigint,
): TxData {
  return asset.__type === 'native'
    ? { to: recipient, data: '0x', value: amount }
    : { to: asset.contract, data: encodeErc20Transfer(recipient, amount), value: 0n };
}

export async function assetBalance(
  host: Host,
  asset: Asset,
  owner: Address,
): Promise<bigint> {
  if (asset.__type === 'native') return host.provider.getBalance(owner);

  const result = await host.provider.call({
    to: asset.contract,
    input: encodeErc20Balance(owner),
  });

  if (!result) throw new Error(`ERC-20 balanceOf returned no data for ${asset.contract}`);

  return decodeErc20Balance(result);
}

/** Notes for the wallet API. */
export function publicNotes(state: ScanState): Note[] {
  return state.matches.flatMap((match) => match.holdings.map((holding) => {
    const asset = restoreAsset(holding.asset);

    return {
      noteId: noteId(match.announcementId, asset),
      address: match.address,
      asset,
      amount: BigInt(holding.amount),
      blockNumber: BigInt(match.blockNumber),
      spent: holding.spent,
    };
  }));
}

export function findStoredNote(state: ScanState, requestedNoteId: Hex): {
  match: StoredMatch;
  holding: StoredHolding;
} | undefined {
  for (const match of state.matches) {
    for (const holding of match.holdings) {
      if (noteId(match.announcementId, restoreAsset(holding.asset)).toLowerCase()
        === requestedNoteId.toLowerCase()) {
        return { match, holding };
      }
    }
  }

  return undefined;
}

export function sameStoredAsset(left: StoredAsset, right: StoredAsset): boolean {
  if (left.type !== right.type) return false;

  if (left.type === 'native') return true;

  return right.type === 'erc20'
    && left.contract.toLowerCase() === right.contract.toLowerCase();
}

/** Stable id for one asset on one announcement. */
function noteId(matchId: Hex, asset: Asset): Hex {
  return keccak256(concatHex([
    matchId,
    bytesToHex(new TextEncoder().encode(assetKey(asset))),
  ]));
}
