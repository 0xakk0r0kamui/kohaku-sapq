export { ViemSignerAdapter } from './signer';

import type { TxLog, TransactionReceipt, CallData } from '../tx';
import type { EthereumProvider } from '../provider';
import { Filter } from 'ox';
import type { PublicClient, RpcLog } from 'viem';

type RequestLogs = (request: {
    method: 'eth_getLogs';
    params: [Filter.Rpc];
}) => Promise<RpcLog[]>;

export const viem = (client: PublicClient): EthereumProvider<PublicClient> => {
    return {
        _internal: client,
        request: client.request.bind(client),
        async getLogs(params: Filter.Filter): Promise<TxLog[]> {
            // Include filter topics in eth_getLogs.
            const request = client.request.bind(client) as RequestLogs;
            const logs = await request({
                method: 'eth_getLogs',
                params: [Filter.toRpc(params)],
            });

            return logs.flatMap((log) => {
                if (log.blockNumber === null) return [];

                return [{
                    address: log.address,
                    blockNumber: BigInt(log.blockNumber),
                    data: log.data,
                    topics: log.topics,
                }];
            });
        },
        async getChainId(): Promise<bigint> {
            return BigInt(await client.getChainId());
        },
        async getBlockNumber(): Promise<bigint> {
            // Skip viem's block-number cache.
            return await client.getBlockNumber({ cacheTime: 0 });
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
            const receipt = await client.getTransactionReceipt({ hash: txHash as `0x${string}` });

            if (!receipt) return null;

            return {
                blockNumber: BigInt(receipt.blockNumber),
                status: receipt.status === 'success' ? 1n : 0n,
                logs: receipt.logs,
                gasUsed: BigInt(receipt.gasUsed),
            };
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
