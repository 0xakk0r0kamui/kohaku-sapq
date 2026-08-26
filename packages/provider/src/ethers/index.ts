import type { JsonRpcProvider, Log } from 'ethers';
import { Filter } from 'ox';
import type { TxLog, TransactionReceipt, CallData, BlockHeader, Hex } from '../tx';
import type { EthereumProvider } from '../provider';
import { AddressLike } from 'ethers';
import { HexString } from '~/raw/hex';
export * from './signer';

/**
 * Ethers v6 provider adapter
 */
export const ethers = (provider: JsonRpcProvider): EthereumProvider<JsonRpcProvider> => {
  return {
    _internal: provider,
    async request({ params, method }) {
      return provider.send(method, params as unknown[]);
    },
    async getLogs({ address, fromBlock, toBlock, topics }: Filter.Filter): Promise<TxLog[]> {
      const logs = await provider.getLogs({
        address: address as AddressLike,
        // blockHash,
        fromBlock,
        toBlock,
        topics: topics as HexString[],
      });

      return logs.map(convertLog);
    },
    async getChainId(): Promise<bigint> {
      return provider._network.chainId;
    },
    async getBlockNumber(): Promise<bigint> {
      return BigInt(await provider.getBlockNumber());
    },
    async getBlockHeader(block = 'latest'): Promise<BlockHeader | null> {
      const value = await provider.getBlock(
        typeof block === 'bigint' ? Number(block) : block,
      );

      if (!value || !value.hash) return null;

      return {
        number: BigInt(value.number),
        hash: value.hash as Hex,
        parentHash: value.parentHash as Hex,
      };
    },
    async waitForTransaction(txHash: string): Promise<void> {
      await provider.waitForTransaction(txHash);
    },
    async getBalance(address: string): Promise<bigint> {
      return await provider.getBalance(address);
    },
    async getCode(address: string): Promise<string> {
      return await provider.getCode(address);
    },
    async getTransactionReceipt(txHash: string): Promise<TransactionReceipt | null> {
      const receipt = await provider.getTransactionReceipt(txHash);

      if (!receipt) return null;

      return {
        blockNumber: BigInt(receipt.blockNumber),
        blockHash: receipt.blockHash as Hex,
        transactionHash: receipt.hash as Hex,
        transactionIndex: BigInt(receipt.index),
        from: receipt.from as Hex,
        to: receipt.to as Hex | null,
        contractAddress: receipt.contractAddress as Hex | null,
        status: BigInt(receipt.status ?? 0),
        logs: receipt.logs.map(convertLog),
        gasUsed: receipt.gasUsed,
        cumulativeGasUsed: receipt.cumulativeGasUsed,
        effectiveGasPrice: receipt.gasPrice,
      };
    },
    async sendRawTransaction(rawTransaction) {
      return await provider.send('eth_sendRawTransaction', [rawTransaction]) as Hex;
    },
    async call(call: CallData): Promise<`0x${string}` | undefined> {
      const result = await provider.call({
        to: call.to,
        from: call.from,
        data: call.input,
        value: call.value ? BigInt(call.value) : undefined,
        gasLimit: call.gas ? BigInt(call.gas) : undefined,
        gasPrice: call.gasPrice ? BigInt(call.gasPrice) : undefined,
      });

      return result as `0x${string}`;
    },
    async estimateGas(call: CallData): Promise<bigint> {
      const gas = await provider.estimateGas({
        to: call.to,
        from: call.from,
        data: call.input,
        value: call.value ? BigInt(call.value) : undefined,
        gasLimit: call.gas ? BigInt(call.gas) : undefined,
        gasPrice: call.gasPrice ? BigInt(call.gasPrice) : undefined,
      });

      return gas;
    },
    async getGasPrice(): Promise<bigint> {
      return await provider.getFeeData().then((feeData) => feeData.gasPrice ?? BigInt(0));
    },
    async getTransactionCount(address: `0x${string}`, block?: number): Promise<number> {
      return await provider.getTransactionCount(address, block ? block : 'latest');
    }
  };
};

const convertLog = (log: Log): TxLog => {
  return {
    blockNumber: BigInt(log.blockNumber),
    blockHash: log.blockHash as Hex,
    transactionHash: log.transactionHash as Hex,
    transactionIndex: BigInt(log.transactionIndex),
    logIndex: BigInt(log.index),
    removed: log.removed,
    topics: [...log.topics] as Hex[],
    data: log.data as Hex,
    address: log.address as Hex,
  };
};
