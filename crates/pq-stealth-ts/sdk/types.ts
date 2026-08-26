import type { AssetId, Host, PluginInstance } from '@kohaku-eth/plugins';
import type { Address, Hex, RawTxSigner, TxRequest } from '@kohaku-eth/provider';

export const SCHEMES = [
  'mlkem-per-payment',
  'hybrid-per-payment',
  'mlkem-channel',
  'hybrid-channel',
] as const;

export type SchemeKind = typeof SCHEMES[number];
export type OperationalMode = 'create' | 'resume' | 'recipient-only';

export type PQStealthPluginParams = {
  accountIndex: number;
  operationalMode: OperationalMode;
  signer?: RawTxSigner;
  deployment: {
    announcerAddress?: Address;
    registryAddress?: Address;
    announcerStartBlock: bigint;
    finalityDepth: bigint;
    scanBatchSize?: number;
  };
  lookahead?: number;
  workerUrl?: string | URL;
};

export type RawRecipient = {
  metaAddress: Hex;
  scheme?: SchemeKind | number;
};

export type RecipientInput = Address | { registrant: Address } | RawRecipient;

export type ResolvedRecipient = {
  scheme: SchemeKind;
  schemeId: number;
  metaAddress: Hex;
  source: 'registry' | 'raw';
};

export type PaymentInput = {
  recipient: RecipientInput;
  scheme: SchemeKind;
  payer: Address;
  asset: AssetId;
  amount: bigint;
};

export type OperationStage =
  | 'Prepared'
  | 'Signed'
  | 'Submitted'
  | 'AnnouncementMined'
  | 'FundingReady'
  | 'FundingSubmitted'
  | 'Complete';

export type OperationPart = 'registration' | 'announcement' | 'funding' | 'spend';

export type SubmissionAttempt = {
  part: OperationPart;
  transactionHash: Hex;
  rawTransaction?: Hex;
  replaces?: Hex;
  submittedAt: number;
  broadcastAt?: number;
};

export type AnnouncementPayload = {
  scheme: SchemeKind;
  scheme_id: number;
  stealth_address: number[];
  ephemeral_pubkey: number[];
  metadata: number[];
};

export type PreparedOperation = {
  id: string;
  kind: 'registration' | 'payment' | 'spend';
  scheme: SchemeKind;
  stage: OperationStage;
  announcement?: AnnouncementPayload;
  transactions: Partial<Record<OperationPart, TxRequest>>;
  attempts: SubmissionAttempt[];
  announcementBlock?: { number: bigint; hash: Hex };
  fundingBlock?: { number: bigint; hash: Hex };
  channelKey?: Hex;
  isChannelOpening?: boolean;
  diagnostics: string[];
  abandoned: boolean;
  createdAt: number;
};

export type MatchMaterial = {
  scheme: SchemeKind;
  stealth_address: number[];
  shared_secret: number[];
  channel_counter?: string | null;
  channel_key?: number[] | null;
};

export type PQStealthNote = {
  id: string;
  eventId: string;
  scheme: SchemeKind;
  address: Address;
  asset: AssetId;
  amount: bigint;
  spent: boolean;
  blockNumber: bigint;
  blockHash: Hex;
  transactionHash: Hex;
  logIndex: bigint;
  announcedMatchesDerived: boolean;
  diagnostics: string[];
};

export type PQStealthBalance = {
  asset: AssetId;
  amount: bigint;
};

export type PrepareSpendInput = {
  noteId: string;
  to: Address;
  amount?: bigint;
  gasLimit?: bigint;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
};

export type TrackingCapability =
  | { capability: 'per-payment-tracking'; scheme: SchemeKind; bytes: Hex }
  | { capability: 'channel-tracking'; scheme: SchemeKind; bytes: Hex }
  | { capability: 'channel-watch'; scheme: SchemeKind; bytes: Hex };

export type RegisterOptions = { schemes?: SchemeKind[] };

export interface PQStealthScanner {
  scan(): Promise<PQStealthNote[]>;
  close(): Promise<void>;
}

export type PQStealthAccountId = `pqsa:${Hex}`;

/** PQ-specific methods exposed as Kohaku plugin extras; no shield/transfer aliases are added. */
export type PQStealthExtras = {
  readonly host: Host;
  readonly params: Readonly<PQStealthPluginParams>;
  register: (options?: RegisterOptions) => Promise<PreparedOperation[]>;
  resolveRecipient: (
    recipient: RecipientInput,
    scheme: SchemeKind,
  ) => Promise<ResolvedRecipient>;
  preparePayment: (input: PaymentInput) => Promise<PreparedOperation>;
  pendingOperations: () => Promise<PreparedOperation[]>;
  submitPreparedOperation: (
    operation: string | PreparedOperation,
  ) => Promise<PreparedOperation>;
  recordSubmission: (
    operation: string | PreparedOperation,
    part: OperationPart,
    transactionHash: Hex,
    rawTransaction?: Hex,
  ) => Promise<PreparedOperation>;
  recordReplacement: (
    operation: string | PreparedOperation,
    part: OperationPart,
    replacedHash: Hex,
    transactionHash: Hex,
    rawTransaction?: Hex,
  ) => Promise<PreparedOperation>;
  refreshOperations: () => Promise<PreparedOperation[]>;
  abandonPreparedOperation: (operation: string | PreparedOperation) => Promise<void>;
  createScanner: () => Promise<PQStealthScanner>;
  prepareSpend: (input: PrepareSpendInput) => Promise<PreparedOperation>;
  signPreparedSpend: (
    operation: string | PreparedOperation,
  ) => Promise<PreparedOperation>;
  submitPreparedSpend: (
    operation: string | PreparedOperation,
  ) => Promise<PreparedOperation>;
  exportTrackingCapability: (
    scheme: SchemeKind,
    options?: { scannerChannel?: Hex },
  ) => Promise<TrackingCapability>;
  notes: (assets?: AssetId[], includeSpent?: boolean) => Promise<PQStealthNote[]>;
};

/** Standard Kohaku plugin surface with PQ payment/scanning methods carried as extras. */
export type PQStealthInstance = PluginInstance<
  PQStealthAccountId,
  {
    assetAmounts: {
      input: PQStealthBalance;
      internal: PQStealthBalance;
      output: PQStealthBalance;
      read: PQStealthBalance;
    };
    features: Record<never, never>;
    note: PQStealthNote;
    extras: PQStealthExtras;
  }
>;

/** @deprecated Use `PQStealthInstance`, the standard Kohaku plugin type. */
export type PQStealthPlugin = PQStealthInstance;

export type { Address, AssetId, Hex, Host, RawTxSigner, TxRequest };
