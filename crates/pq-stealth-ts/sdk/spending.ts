import type { Host } from '@kohaku-eth/plugins';
import {
  hexToBytes,
  isAddress,
  isHex,
  numberToHex,
  size,
  type Address,
  type Hex,
} from 'viem';
import { assetTransfer, findStoredNote, restoreAsset } from './assets.js';
import { validateAmount } from './config.js';
import { readRecord, type ScanState } from './storage.js';
import type {
  Identity,
  SignedSpend,
  SpendInput,
} from './types.js';
import { signSpend, type Match } from './wasm.js';

const MAX_U64 = (1n << 64n) - 1n;

/** Look up an unspent note, fill gas fields, and sign the spend. */
export async function prepareSpend(
  host: Host,
  chainId: bigint,
  keygenMaster: Uint8Array,
  identity: Identity,
  storageKey: string,
  input: SpendInput,
): Promise<SignedSpend> {
  validateAmount(input.amount);

  if (!isAddress(input.recipient)) throw new Error('Spend recipient is invalid');

  const state = await readRecord<ScanState>(host.storage, storageKey);
  const found = state && findStoredNote(state, input.noteId);

  if (!found || found.holding.spent) throw new Error(`Unknown unspent note ${input.noteId}`);

  if (input.amount > BigInt(found.holding.amount)) {
    throw new Error('Spend amount exceeds the current note balance');
  }

  const transaction = assetTransfer(
    restoreAsset(found.holding.asset),
    input.recipient,
    input.amount,
  );
  const from = found.match.address;
  const gasPrice = await host.provider.getGasPrice();
  const [gasLimit, nonce, nativeBalance] = await Promise.all([
    input.gasLimit === undefined
      ? host.provider.estimateGas({
        to: transaction.to as Address,
        from,
        input: transaction.data as Hex,
        value: numberToHex(transaction.value),
      })
      : Promise.resolve(input.gasLimit),
    host.provider.getTransactionCount(from),
    host.provider.getBalance(from),
  ]);
  const maxPriorityFeePerGas = input.maxPriorityFeePerGas ?? max(1n, gasPrice / 10n);
  const maxFeePerGas = input.maxFeePerGas ?? gasPrice * 2n + maxPriorityFeePerGas;

  if (gasLimit <= 0n || maxPriorityFeePerGas < 0n || maxFeePerGas < maxPriorityFeePerGas) {
    throw new Error('Invalid EIP-1559 gas or fee fields');
  }

  const transferredValue = found.holding.asset.type === 'native' ? input.amount : 0n;

  if (transferredValue + gasLimit * maxFeePerGas > nativeBalance) {
    throw new Error('Stealth address cannot cover the transfer value and maximum gas cost');
  }

  assertU64(chainId, 'chain id');
  assertU64(BigInt(nonce), 'nonce');
  assertU64(gasLimit, 'gas limit');

  const matched: Match = {
    stealth_address: Array.from(hexToBytes(found.match.address)),
    shared_secret: Array.from(hexToBytes(found.match.sharedSecret)),
  };
  const signed = await signSpend(
    keygenMaster,
    identity.keygenIndex,
    matched,
    {
      chainId,
      nonce: BigInt(nonce),
      gasLimit,
      maxFeePerGas,
      maxPriorityFeePerGas,
      to: transaction.to as Address,
      value: transaction.value,
      data: transaction.data as Hex,
    },
  );

  if (signed.signer.toLowerCase() !== from.toLowerCase()) {
    throw new Error('Derived signer does not control the matched stealth address');
  }

  return {
    ...signed,
    transaction: {
      ...transaction,
      from,
      chainId,
      nonce,
      gasLimit,
      maxFeePerGas,
      maxPriorityFeePerGas,
    },
  };
}

/** Broadcast the signed tx. */
export async function submitSpend(host: Host, spend: SignedSpend): Promise<Hex> {
  const result = await host.provider.request({
    method: 'eth_sendRawTransaction',
    params: [spend.rawTransaction],
  });

  if (typeof result !== 'string' || !isHex(result, { strict: true }) || size(result) !== 32) {
    throw new Error('RPC returned an invalid transaction hash');
  }

  if (result.toLowerCase() !== spend.transactionHash.toLowerCase()) {
    throw new Error(`RPC returned ${result}, expected ${spend.transactionHash}`);
  }

  return result;
}

function assertU64(value: bigint, field: string): void {
  if (value < 0n || value > MAX_U64) throw new Error(`${field} does not fit uint64`);
}

function max(left: bigint, right: bigint): bigint {
  return left > right ? left : right;
}
