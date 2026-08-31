import type {
  ERC20AssetId,
  Host,
  NativeAssetId,
  PluginInstance,
} from '@kohaku-eth/plugins';
import type { TxData } from '@kohaku-eth/provider';
import type { Address, Hex } from 'viem';

export type Asset = NativeAssetId | ERC20AssetId;
export type OperationalMode = 'create' | 'resume' | 'receive-only';

export type PluginParams = {
  readonly accountIndex: number;
  readonly mode: OperationalMode;
  readonly assets: readonly Asset[];
  readonly deployment: {
    readonly announcer: Address;
    readonly registry: Address;
    readonly announcerStartBlock: bigint;
    readonly finalityDepth?: bigint;
    readonly scanBatchSize?: bigint;
    readonly rescanBlocks?: bigint;
  };
};

export type Identity = {
  schemeId: 3;
  keygenIndex: bigint;
  metaAddress: Hex;
};

export type Recipient = Address | { registrant: Address } | { metaAddress: Hex };

export type Announcement = {
  schemeId: 3;
  stealthAddress: Address;
  ephemeralPublicKey: Hex;
  metadata: Hex;
};

export type PreparedPayment = {
  announcement: Announcement;
  announcementTransaction: TxData;
  fundingTransaction: TxData;
};

export type PaymentInput = {
  recipient: Recipient;
  asset: Asset;
  amount: bigint;
};

export type Note = {
  noteId: Hex;
  address: Address;
  asset: Asset;
  amount: bigint;
  blockNumber: bigint;
  spent: boolean;
};

export type Balance = {
  asset: Asset;
  amount: bigint;
};

export type SpendInput = {
  noteId: Hex;
  recipient: Address;
  amount: bigint;
  gasLimit?: bigint;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
};

export type SignedSpend = {
  rawTransaction: Hex;
  transactionHash: Hex;
  signer: Address;
  transaction: Omit<TxData, 'from' | 'chainId' | 'nonce' | 'gasLimit' | 'maxFeePerGas' | 'maxPriorityFeePerGas'> & {
    from: Address;
    chainId: bigint;
    nonce: number;
    gasLimit: bigint;
    maxFeePerGas: bigint;
    maxPriorityFeePerGas: bigint;
  };
};

export type PluginExtras = {
  readonly host: Host;
  readonly params: PluginParams;
  identity(): Identity;
  registrationTransaction(): TxData;
  resolveRecipient(recipient: Recipient): Promise<Hex>;
  preparePayment(input: PaymentInput): Promise<PreparedPayment>;
  scan(): Promise<Note[]>;
  prepareSpend(input: SpendInput): Promise<SignedSpend>;
  submitSpend(spend: SignedSpend): Promise<Hex>;
};

export type Scheme3Instance = PluginInstance<
  `pqsa3:${Hex}`,
  {
    assetAmounts: {
      input: Balance;
      internal: Balance;
      output: Balance;
      read: Balance;
    };
    features: Record<never, never>;
    note: Note;
    extras: PluginExtras;
  }
>;

export type { Address, Hex, Host, TxData };
