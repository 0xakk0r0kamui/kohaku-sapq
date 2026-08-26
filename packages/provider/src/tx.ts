/** A 0x-prefixed byte string. */
export type Hex = `0x${string}`;

/** A 20-byte Ethereum address. */
export type Address = `0x${string}`;

/** The canonical identity and payload of an Ethereum log. */
export interface TxLog {
    blockNumber: bigint;
    blockHash: Hex;
    transactionHash: Hex;
    transactionIndex: bigint;
    logIndex: bigint;
    removed: boolean;
    address: Address;
    topics: Hex[];
    data: Hex;
}

/** The block identity needed to detect and replay reorged scan tails. */
export interface BlockHeader {
    number: bigint;
    hash: Hex;
    parentHash: Hex;
}

/** Receipt fields shared by the raw, Ethers and Viem adapters. */
export interface TransactionReceipt {
    blockNumber: bigint;
    blockHash: Hex;
    transactionHash: Hex;
    transactionIndex: bigint;
    from: Address;
    to: Address | null;
    contractAddress: Address | null;
    status: bigint;
    logs: TxLog[];
    gasUsed: bigint;
    cumulativeGasUsed: bigint;
    effectiveGasPrice: bigint;
}

export type AccessListEntry = {
    address: Address;
    storageKeys: Hex[];
};

/** A signable transaction, including EIP-1559 fee-market fields. */
export type TxRequest = {
    to?: Address;
    from?: Address;
    data?: Hex;
    value?: bigint;
    chainId?: bigint;
    nonce?: number;
    gas?: bigint;
    gasLimit?: bigint;
    gasPrice?: bigint;
    maxFeePerGas?: bigint;
    maxPriorityFeePerGas?: bigint;
    type?: 0 | 1 | 2;
    accessList?: AccessListEntry[];
};

/** Backwards-compatible minimal transaction payload used by existing plugins. */
export type TxData = TxRequest & {
    to: Address;
    data: Hex;
    value: bigint;
};

export type CallData = {
    to: Address;
    from?: Address | undefined;
    gas?: Hex | undefined;
    gasPrice?: Hex | undefined;
    value?: Hex | undefined;
    input?: Hex | undefined;
    block?: Hex | 'latest' | 'pending' | 'earliest' | undefined;
}

export const createTx = (address: string, payload: string, value: bigint = BigInt(0)): TxData => {
    return {
        to: address as Address,
        data: payload as Hex,
        value: value,
    };
};
