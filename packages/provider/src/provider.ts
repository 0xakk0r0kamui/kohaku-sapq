import { Filter } from "ox/Filter";
import { TxLog, TransactionReceipt, CallData, TxRequest, BlockHeader, Hex } from "./tx";
import { RpcRequest } from "ox/RpcRequest";

/**
 * Abstract provider interface for blockchain interactions
 * Supports both Ethers v6 and Viem implementations
 */
export type EthereumProvider<T = unknown> = {
  _internal: T;

  /**
   * Get the chain ID
   */
  getChainId(): Promise<bigint>;

  /**
   * Fetch logs from the blockchain
   */
  getLogs(params: Filter): Promise<TxLog[]>;

  /**
   * Get the current block number
   */
  getBlockNumber(): Promise<bigint>;

  /** Get a block's canonical identity for reorg detection. */
  getBlockHeader(block?: bigint | 'latest' | 'pending' | 'earliest'): Promise<BlockHeader | null>;

  /**
   * Wait for a transaction to be mined
   */
  waitForTransaction(txHash: string): Promise<void>;

  /**
   * Get the balance of an address
   */
  getBalance(address: string): Promise<bigint>;

  /**
   * Get the code at an address
   */
  getCode(address: string): Promise<string>;

  /**
   * Get transaction receipt
   */
  getTransactionReceipt(txHash: string): Promise<TransactionReceipt | null>;

  /** Broadcast an already signed transaction without rebuilding it. */
  sendRawTransaction(rawTransaction: Hex): Promise<Hex>;

  /**
   * Generic make request method to be able to use ABIs
   */
  request(request: Pick<RpcRequest, 'method' | 'params'>): Promise<unknown>;

  /**
   * Make a call to the blockchain without sending a transaction
   */
  call(call: CallData): Promise<`0x${string}` | undefined>;

  /**
   * Estimate gas for a transaction
   */
  estimateGas(call: CallData): Promise<bigint>;

  /**
   * Get the current gas price
   */
  getGasPrice(): Promise<bigint>;

  /**
   * Gets the transaction count (nonce) for an address, optionally at a specific block
   */
  getTransactionCount(address: `0x${string}`, block?: number): Promise<number>;
}

/**
 * Abstract signer interface for transaction signing and submission
 * Supports both Ethers v6 and Viem implementations
 */
export interface TxSigner {
  /**
   * Sign a message
   */
  signMessage(message: string | Uint8Array): Promise<string>;

  /**
   * Send a transaction
   */
  sendTransaction(tx: TxRequest): Promise<string>;

  /** Sign without broadcasting so exact raw bytes can be persisted first. */
  signTransaction(tx: TxRequest): Promise<Hex>;

  /**
   * Get the signer's address
   */
  getAddress(): Promise<string>;
}

/** A signer suitable for managed raw-transaction submission. */
export type RawTxSigner = Pick<TxSigner, 'getAddress' | 'signTransaction'>;
