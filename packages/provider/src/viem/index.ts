export { ViemSignerAdapter } from './signer';

import type { TxLog, TransactionReceipt, CallData, BlockHeader, Hex } from '../tx';
import type { EthereumProvider } from '../provider';
import { Filter } from 'ox';
import { TransactionReceiptNotFoundError, toHex, type PublicClient } from 'viem';

type ViemLog = Awaited<ReturnType<PublicClient['getLogs']>>[number];
type RpcLog = {
    blockNumber: Hex | null;
    blockHash: Hex | null;
    transactionHash: Hex | null;
    transactionIndex: Hex | null;
    logIndex: Hex | null;
    removed?: boolean;
    address: Hex;
    topics: Hex[];
    data: Hex;
};

type RpcBlock = {
    number: Hex | null;
    hash: Hex | null;
    parentHash: Hex;
};

const convertLog = (log: ViemLog): TxLog => ({
    blockNumber: log.blockNumber ?? 0n,
    blockHash: log.blockHash as Hex,
    transactionHash: log.transactionHash as Hex,
    transactionIndex: BigInt(log.transactionIndex ?? 0),
    logIndex: BigInt(log.logIndex ?? 0),
    removed: log.removed,
    address: log.address,
    topics: [...log.topics] as Hex[],
    data: log.data,
});

const convertRpcLog = (log: RpcLog): TxLog => ({
    blockNumber: BigInt(log.blockNumber ?? 0),
    blockHash: log.blockHash ?? '0x',
    transactionHash: log.transactionHash ?? '0x',
    transactionIndex: BigInt(log.transactionIndex ?? 0),
    logIndex: BigInt(log.logIndex ?? 0),
    removed: log.removed ?? false,
    address: log.address,
    topics: [...log.topics],
    data: log.data,
});

export const viem = (client: PublicClient): EthereumProvider<PublicClient> => {
    return {
        _internal: client,
        request: client.request.bind(client),
        async getLogs(params: Filter.Filter): Promise<TxLog[]> {
            // Viem's high-level getLogs action builds topics only from typed ABI events and
            // silently ignores a raw `topics` property. Use the client's RPC transport so the
            // caller's exact topic matrix reaches eth_getLogs.
            const logs = await client.request({
                method: 'eth_getLogs',
                params: [Filter.toRpc(params)],
            } as never) as RpcLog[];

            return logs.map(convertRpcLog);
        },
        async getChainId(): Promise<bigint> {
            return BigInt(await client.getChainId());
        },
        async getBlockNumber(): Promise<bigint> {
            // Do not use viem's short-lived action cache: scanners must observe a block mined
            // immediately before this call or they can persist an accidentally stale cursor.
            return BigInt(await client.request({ method: 'eth_blockNumber' } as never) as Hex);
        },
        async getBlockHeader(block = 'latest'): Promise<BlockHeader | null> {
            const value = await client.request({
                method: 'eth_getBlockByNumber',
                params: [typeof block === 'bigint' ? toHex(block) : block, false],
            } as never) as RpcBlock | null;

            if (!value?.hash || value.number == null) return null;

            return { number: BigInt(value.number), hash: value.hash, parentHash: value.parentHash };
        },
        async waitForTransaction(txHash: string): Promise<void> {
            await client.waitForTransactionReceipt({ hash: txHash as `0x${string}` });
        },
        async getBalance(address: string): Promise<bigint> {
            return client.getBalance({ address: address as `0x${string}` });
        },
        async getCode(address: string): Promise<string> {
            const code = await client.getCode({ address: address as `0x${string}` });

            return code ?? '0x';
        },
        async getTransactionReceipt(txHash: string): Promise<TransactionReceipt | null> {
            let receipt: Awaited<ReturnType<PublicClient['getTransactionReceipt']>>;

            try {
                receipt = await client.getTransactionReceipt({ hash: txHash as `0x${string}` });
            } catch (error) {
                // `viem` may be installed more than once in a workspace, making `instanceof`
                // fail across package copies even for its canonical not-found error.
                if (error instanceof TransactionReceiptNotFoundError
                    || (error as { name?: string }).name === 'TransactionReceiptNotFoundError') {
                    return null;
                }

                throw error;
            }

            if (!receipt) return null;

            return {
                blockNumber: BigInt(receipt.blockNumber),
                blockHash: receipt.blockHash,
                transactionHash: receipt.transactionHash,
                transactionIndex: BigInt(receipt.transactionIndex),
                from: receipt.from,
                to: receipt.to,
                contractAddress: receipt.contractAddress ?? null,
                status: receipt.status === 'success' ? 1n : 0n,
                logs: receipt.logs.map(convertLog),
                gasUsed: BigInt(receipt.gasUsed),
                cumulativeGasUsed: receipt.cumulativeGasUsed,
                effectiveGasPrice: receipt.effectiveGasPrice,
            };
        },
        async sendRawTransaction(rawTransaction) {
            return await client.sendRawTransaction({ serializedTransaction: rawTransaction });
        },
        async call(call: CallData): Promise<`0x${string}` | undefined> {
            const result = await client.call({
                to: call.to,
                account: call.from,
                data: call.input,
                value: call.value ? BigInt(call.value) : undefined,
                gas: call.gas ? BigInt(call.gas) : undefined,
                gasPrice: call.gasPrice ? BigInt(call.gasPrice) : undefined,
            });

            return result.data;
        },
        async estimateGas(call: CallData): Promise<bigint> {
            const gas = await client.estimateGas({
                to: call.to,
                account: call.from,
                data: call.input,
                value: call.value ? BigInt(call.value) : undefined,
            });

            return gas;
        },
        async getGasPrice(): Promise<bigint> {
            return await client.getGasPrice();
        },
        async getTransactionCount(address: `0x${string}`, block?: number): Promise<number> {
            return await client.getTransactionCount({ address: address, blockNumber: block ? BigInt(block) : undefined });

        }
    };
};
