import type { TxSigner } from '../provider';
import type { Hex, TxRequest } from '../tx';
import type { WalletClient } from 'viem';

export class ViemSignerAdapter implements TxSigner {
  constructor(private readonly wallet: WalletClient) {}

  async signMessage(message: string | Uint8Array): Promise<string> {
    return this.wallet.signMessage({
      account: this.wallet.account!,
      message: typeof message === 'string' ? message : { raw: message },
    });
  }

  async sendTransaction(tx: TxRequest): Promise<string> {
    if (!tx.to) throw new Error('Contract creation is not supported by this adapter');

    this.assertRequestOwner(tx);

    return this.wallet.sendTransaction({
      account: this.wallet.account!,
      chain: this.wallet.chain!,
      to: tx.to as `0x${string}`,
      data: tx.data as `0x${string}`,
      value: tx.value ?? 0n,
      gas: tx.gas ?? tx.gasLimit,
      gasPrice: tx.gasPrice,
      maxFeePerGas: tx.maxFeePerGas,
      maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
      nonce: tx.nonce,
      accessList: tx.accessList,
    } as never);
  }

  async signTransaction(tx: TxRequest): Promise<Hex> {
    if (!tx.to) throw new Error('Contract creation is not supported by this adapter');

    this.assertRequestOwner(tx);

    return this.wallet.signTransaction({
      account: this.wallet.account!,
      chain: this.wallet.chain!,
      to: tx.to,
      data: tx.data,
      value: tx.value ?? 0n,
      gas: tx.gas ?? tx.gasLimit,
      gasPrice: tx.gasPrice,
      maxFeePerGas: tx.maxFeePerGas,
      maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
      nonce: tx.nonce,
      accessList: tx.accessList,
    } as never);
  }

  async getAddress(): Promise<string> {
    if (!this.wallet.account) {
      throw new Error('Wallet client does not have an account');
    }

    return this.wallet.account.address;
  }

  private assertRequestOwner(tx: TxRequest): void {
    if (!this.wallet.account) throw new Error('Wallet client does not have an account');

    if (tx.from && tx.from.toLowerCase() !== this.wallet.account.address.toLowerCase()) {
      throw new Error(`Transaction from ${tx.from} does not match wallet account`);
    }

    if (tx.chainId != null && this.wallet.chain
      && tx.chainId !== BigInt(this.wallet.chain['id'])) {
      throw new Error(`Transaction chain ${tx.chainId} does not match wallet chain`);
    }
  }
}
