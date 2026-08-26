import { Hex } from "ox/Hex";
import { EthereumProvider, TransactionReceipt, TxLog, CallData, BlockHeader } from "..";
import { HexString, hexToBigInt } from "./hex";
import { Provider } from 'ox/Provider';
import { Block, Filter } from "ox";
import { toHex } from "viem";

export const raw = (client: Provider): EthereumProvider<Provider> => {
    const getTransactionReceipt = async (txHash: string): Promise<TransactionReceipt | null> => {
        const receipt = await client.request({
            method: 'eth_getTransactionReceipt',
            params: [txHash as Hex],
        }) as RpcReceipt;

        if (!receipt) return null;

        return convertReceipt(receipt);
    };

    return {
        _internal: client,
        request: client.request.bind(client),
        async getLogs(params: Filter.Filter): Promise<TxLog[]> {
            const logs = await client.request({
                method: 'eth_getLogs',
                params: [Filter.toRpc(params)],
            });

            return logs.map(convertLog);
        },
        async getChainId(): Promise<bigint> {
            const hex = await client.request({
                method: 'eth_chainId',
                params: undefined,
            });

            return hexToBigInt(hex);
        },
        async getBlockNumber(): Promise<bigint> {
            const hex = await client.request({
                method: 'eth_blockNumber',
                params: undefined,
            });

            return hexToBigInt(hex);
        },
        async getBlockHeader(block = 'latest'): Promise<BlockHeader | null> {
            const number = typeof block === 'bigint' ? toHex(block) : block;
            const value = await client.request({
                method: 'eth_getBlockByNumber',
                params: [number, false],
            }) as RpcBlock | null;

            if (!value || value.number == null || value.hash == null) return null;

            return {
                number: hexToBigInt(value.number),
                hash: value.hash,
                parentHash: value.parentHash,
            };
        },
        async waitForTransaction(txHash: string): Promise<void> {
            const start = Date.now();

            const timeoutMs = 10000;
            const pollIntervalMs = 100;

            while (true) {
                const receipt = await getTransactionReceipt(txHash);

                if (receipt) return;

                if (Date.now() - start > timeoutMs) {
                    throw new Error(`Timed out waiting for transaction: ${txHash}`);
                }

                await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
            }
        },
        async getBalance(address: Hex, block?: Block.Identifier | Block.Tag): Promise<bigint> {
            const hex = await client.request({
                method: 'eth_getBalance',
                params: [address, block ?? 'latest'],
            }) as HexString;

            return hexToBigInt(hex);
        },
        async getCode(address: Hex, block?: Block.Identifier | Block.Tag): Promise<string> {
            const hex = await client.request({
                method: 'eth_getCode',
                params: [address, block ?? 'latest'],
            }) as HexString;

            return hex ?? '0x';
        },
        async call(call: CallData): Promise<`0x${string}` | undefined> {
            const result = await client.request({
                method: 'eth_call',
                params: [call, call.block ?? 'latest'],
            }) as `0x${string}`;

            return result;
        },
        async estimateGas(call: CallData): Promise<bigint> {
            const hex = await client.request({
                method: 'eth_estimateGas',
                params: [call],
            }) as HexString;

            return hexToBigInt(hex);
        },
        async getGasPrice(): Promise<bigint> {
            const hex = await client.request({
                method: 'eth_gasPrice',
                params: undefined,
            }) as HexString;

            return hexToBigInt(hex);
        },
        getTransactionReceipt,
        async sendRawTransaction(rawTransaction) {
            return await client.request({
                method: 'eth_sendRawTransaction',
                params: [rawTransaction],
            }) as Hex;
        },
        async getTransactionCount(address: `0x${string}`, block?: number): Promise<number> {
            const hex = await client.request({
                method: 'eth_getTransactionCount',
                params: [address, block ? toHex(block) : 'latest'],
            }) as HexString;

            return Number(hexToBigInt(hex));
        }
    }
}

type RpcLog = {
    blockNumber: HexString;
    blockHash: Hex;
    transactionHash: Hex;
    transactionIndex: HexString;
    logIndex: HexString;
    removed?: boolean;
    topics: Hex[];
    data: HexString;
    address: HexString;
};

type RpcBlock = {
    number: HexString | null;
    hash: Hex | null;
    parentHash: Hex;
};

type RpcReceipt = {
    blockNumber: HexString;
    blockHash: Hex;
    transactionHash: Hex;
    transactionIndex: HexString;
    from: Hex;
    to: Hex | null;
    contractAddress: Hex | null;
    status?: HexString;
    logs: RpcLog[];
    gasUsed: HexString;
    cumulativeGasUsed: HexString;
    effectiveGasPrice?: HexString;
};

const convertLog = (log: RpcLog): TxLog => ({
    blockNumber: hexToBigInt(log.blockNumber),
    blockHash: log.blockHash,
    transactionHash: log.transactionHash,
    transactionIndex: hexToBigInt(log.transactionIndex),
    logIndex: hexToBigInt(log.logIndex),
    removed: log.removed ?? false,
    topics: [...log.topics],
    data: log.data as Hex,
    address: log.address as Hex,
});

const convertReceipt = (receipt: RpcReceipt): TransactionReceipt => ({
    blockNumber: hexToBigInt(receipt.blockNumber),
    blockHash: receipt.blockHash,
    transactionHash: receipt.transactionHash,
    transactionIndex: hexToBigInt(receipt.transactionIndex),
    from: receipt.from,
    to: receipt.to,
    contractAddress: receipt.contractAddress,
    status: receipt.status ? hexToBigInt(receipt.status) : BigInt(0),
    logs: receipt.logs.map(convertLog),
    gasUsed: hexToBigInt(receipt.gasUsed),
    cumulativeGasUsed: hexToBigInt(receipt.cumulativeGasUsed),
    effectiveGasPrice: receipt.effectiveGasPrice ? hexToBigInt(receipt.effectiveGasPrice) : 0n,
});
