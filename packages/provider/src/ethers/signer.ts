import type { TxSigner } from '../provider';
import type { Hex, TxRequest } from '../tx';
import type { Wallet } from 'ethers';

/**
 * Ethers v6 signer adapter
 */
export class EthersSignerAdapter implements TxSigner {
  constructor(private readonly signer: Wallet) {}

  async signMessage(message: string | Uint8Array): Promise<string> {
    return await this.signer.signMessage(message);
  }

  async sendTransaction(tx: TxRequest): Promise<string> {
    const txResponse = await this.signer.sendTransaction(this.toEthersRequest(tx));

    return txResponse.hash;
  }

  async signTransaction(tx: TxRequest): Promise<Hex> {
    return await this.signer.signTransaction(this.toEthersRequest(tx)) as Hex;
  }

  async getAddress(): Promise<string> {
    return await this.signer.getAddress();
  }

  private toEthersRequest(tx: TxRequest) {
    return {
      to: tx.to,
      from: tx.from,
      data: tx.data,
      value: tx.value,
      chainId: tx.chainId,
      nonce: tx.nonce,
      gasLimit: tx.gasLimit ?? tx.gas,
      gasPrice: tx.gasPrice,
      maxFeePerGas: tx.maxFeePerGas,
      maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
      type: tx.type,
      accessList: tx.accessList,
    };
  }
}
