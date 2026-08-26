import type { AssetId, CreatePluginFn, Host } from '@kohaku-eth/plugins';
import type { Address, Hex, TransactionReceipt, TxRequest } from '@kohaku-eth/provider';
import { keccak256, numberToHex, stringToHex } from 'viem';
import { BoundScanner, assetKey, publicNote } from './scanner.js';
import { PQStealthError } from './errors.js';
import {
  emptyCheckpoint,
  publicOperation,
  readRecord,
  restoreAsset,
  restoreTx,
  storeAsset,
  storeTx,
  type ChannelRecord,
  type IdentityRecord,
  type OperationBook,
  type ReservationDraft,
  type ScannerCheckpoint,
  type SenderChannelBook,
  type SenderEntropyRecord,
  type StoredOperation,
  withStorageLock,
  writeRecord,
} from './storage.js';
import {
  SCHEMES,
  type OperationPart,
  type PaymentInput,
  type PQStealthBalance,
  type PQStealthAccountId,
  type PQStealthInstance,
  type PQStealthNote,
  type PQStealthPluginParams,
  type PrepareSpendInput,
  type PreparedOperation,
  type RecipientInput,
  type RegisterOptions,
  type ResolvedRecipient,
  type SchemeKind,
  type TrackingCapability,
} from './types.js';
import {
  addressBytes,
  bindings,
  buildAssetTransfer,
  byteHex,
  deriveIdentity,
  ensureInitialized,
  hexBytes,
  signSpend,
  verifyAssetTransferReceipt,
} from './wasm.js';

export const DEFAULT_ANNOUNCER = '0x55649e01b5df198d18d95b5cc5051630cfd45564' as Address;
export const DEFAULT_REGISTRY = '0x6538e6bf4b0ebd30a8ea093027ac2422ce5d6538' as Address;
const DEFAULT_LOOKAHEAD = 20;
const DEFAULT_SCAN_BATCH_SIZE = 2_000;

type ReservationOutput = {
  announcement: StoredOperation['announcement'];
  sender_channel?: number[] | null;
};

export class PQStealthProtocol implements PQStealthInstance {
  readonly schemes = SCHEMES;
  readonly lookahead: number;
  readonly scanBatchSize: number;
  readonly announcerAddress: Address;
  readonly registryAddress: Address;
  readonly chainId: bigint;
  readonly keygenMaster: Uint8Array;
  readonly senderMaster?: Uint8Array;

  private readonly baseKey: string;

  private constructor(
    readonly host: Host,
    readonly params: Readonly<PQStealthPluginParams>,
    context: {
      chainId: bigint;
      keygenMaster: Uint8Array;
      senderMaster?: Uint8Array;
    },
  ) {
    this.chainId = context.chainId;
    this.keygenMaster = context.keygenMaster;
    this.senderMaster = context.senderMaster;
    this.lookahead = params.lookahead ?? DEFAULT_LOOKAHEAD;
    this.scanBatchSize = params.deployment.scanBatchSize ?? DEFAULT_SCAN_BATCH_SIZE;
    this.announcerAddress = params.deployment.announcerAddress ?? DEFAULT_ANNOUNCER;
    this.registryAddress = params.deployment.registryAddress ?? DEFAULT_REGISTRY;
    this.baseKey = `pq-stealth:v1:${params.accountIndex}`;
  }

  static async create(host: Host, params: PQStealthPluginParams): Promise<PQStealthProtocol> {
    validateParams(params);
    await ensureInitialized();
    const chainId = await host.provider.getChainId();
    const announcerAddress = params.deployment.announcerAddress ?? DEFAULT_ANNOUNCER;
    const registryAddress = params.deployment.registryAddress ?? DEFAULT_REGISTRY;
    const [announcerCode, registryCode] = await Promise.all([
      host.provider.getCode(announcerAddress),
      host.provider.getCode(registryAddress),
    ]);
    if (announcerCode === '0x') throw new Error(`No ERC-5564 bytecode at ${announcerAddress}`);
    if (registryCode === '0x') throw new Error(`No ERC-6538 bytecode at ${registryAddress}`);

    const keygenMaster = hexBytes(await host.keystore.deriveAt(
      `m/5564'/60'/${params.accountIndex}'/0'`,
    ));
    const senderMaster = params.operationalMode === 'recipient-only'
      ? undefined
      : hexBytes(await host.keystore.deriveAt(`m/5564'/60'/${params.accountIndex}'/1'`));
    const plugin = new PQStealthProtocol(host, params, { chainId, keygenMaster, senderMaster });
    await withStorageLock(host.storage, async () => {
      await plugin.initializeIdentities();
      await plugin.initializeSenderState();
      await plugin.recoverReservationsLocked();
    });
    return plugin;
  }

  async identity(scheme: SchemeKind): Promise<IdentityRecord> {
    const identity = await readRecord<IdentityRecord>(this.host.storage, this.identityKey(scheme));
    if (!identity) throw new PQStealthError('MissingOperationalState', `Missing ${scheme} identity`);
    return identity;
  }

  async instanceId(): Promise<PQStealthAccountId> {
    const identities = await Promise.all(SCHEMES.map((scheme) => this.identity(scheme)));
    const manifest = identities
      .map((identity) => `${identity.scheme_id}:${byteHex(identity.meta_address)}`)
      .join('|');
    return `pqsa:${keccak256(stringToHex(manifest))}`;
  }

  scannerKey(scheme: SchemeKind): string {
    return `${this.baseKey}:chain:${this.chainId}:scanner:${scheme}`;
  }

  async register(options: RegisterOptions = {}): Promise<PreparedOperation[]> {
    const schemes = options.schemes ?? [...SCHEMES];
    return withStorageLock(this.host.storage, async () => {
      const book = await this.operationBook();
      const prepared: StoredOperation[] = [];
      for (const scheme of schemes) {
        const identity = await this.identity(scheme);
        const data = byteHex(bindings.encode_register_call(
          BigInt(identity.scheme_id),
          Uint8Array.from(identity.meta_address),
        ));
        const operation: StoredOperation = {
          id: operationId('registration', scheme, `${Date.now()}:${book.operations.length}`),
          kind: 'registration',
          scheme,
          stage: 'Prepared',
          transactions: {
            registration: storeTx({ to: this.registryAddress, data, value: 0n }),
          },
          attempts: [],
          diagnostics: [],
          abandoned: false,
          createdAt: Date.now(),
        };
        book.operations.push(operation);
        prepared.push(operation);
      }
      await writeRecord(this.host.storage, this.operationsKey(), book);
      return prepared.map(publicOperation);
    });
  }

  async resolveRecipient(recipient: RecipientInput, scheme: SchemeKind): Promise<ResolvedRecipient> {
    const identity = await this.identity(scheme);
    let source: ResolvedRecipient['source'];
    let metaAddress: Hex;
    if (typeof recipient === 'string' || 'registrant' in recipient) {
      const registrant = typeof recipient === 'string' ? recipient : recipient.registrant;
      const call = byteHex(bindings.encode_registry_lookup(
        addressBytes(registrant),
        BigInt(identity.scheme_id),
      ));
      const encoded = await this.host.provider.call({ to: this.registryAddress, input: call });
      if (!encoded) throw new PQStealthError('MalformedMetaAddress', 'Registry returned no data');
      metaAddress = byteHex(bindings.decode_registry_lookup(hexBytes(encoded)));
      source = 'registry';
    } else {
      if (recipient.scheme != null) {
        const agrees = typeof recipient.scheme === 'number'
          ? recipient.scheme === identity.scheme_id
          : recipient.scheme === scheme;
        if (!agrees) {
          throw new PQStealthError(
            'MalformedMetaAddress',
            'Raw recipient scheme disagrees with the requested scheme',
          );
        }
      }
      metaAddress = recipient.metaAddress;
      source = 'raw';
    }
    if (!bindings.validate_meta_address(scheme, hexBytes(metaAddress))) {
      throw new PQStealthError('MalformedMetaAddress', `Invalid ${scheme} meta-address`);
    }
    return { scheme, schemeId: identity.scheme_id, metaAddress, source };
  }

  async preparePayment(input: PaymentInput): Promise<PreparedOperation> {
    this.requireSender();
    const resolved = await this.resolveRecipient(input.recipient, input.scheme);
    return withStorageLock(this.host.storage, async () => {
      if (input.scheme.endsWith('-channel')) {
        const key = channelKey(this.chainId, input.scheme, resolved.metaAddress);
        const channelBook = await this.channelBook(input.scheme);
        const existing = channelBook.channels.find((channel) => channel.key === key);
        if (existing?.status === 'opening') {
          throw new PQStealthError(
            'ChannelOpeningPending',
            `Channel opening is pending: ${existing.opening.id}`,
            existing.opening.id,
          );
        }
        if (existing?.status === 'abandoned') {
          throw new PQStealthError(
            'InvalidOperationState',
            `Channel ${existing.opening.id} was abandoned`,
            existing.opening.id,
          );
        }
        if (existing?.status === 'active') {
          return publicOperation(await this.prepareMemoLocked(existing, channelBook, input));
        }
      }
      return publicOperation(await this.reserveOpeningLocked(input, resolved));
    });
  }

  async pendingOperations(): Promise<PreparedOperation[]> {
    const operations = await this.allOperations();
    return operations
      .filter((operation) => operation.stage !== 'Complete' && !operation.abandoned)
      .map(publicOperation);
  }

  async submitPreparedOperation(operation: string | PreparedOperation): Promise<PreparedOperation> {
    if (!this.params.signer) {
      throw new PQStealthError(
        'SignerUnavailable',
        'No RawTxSigner was configured; broadcast externally and call recordSubmission()',
      );
    }
    const id = typeof operation === 'string' ? operation : operation.id;
    return withStorageLock(this.host.storage, async () => {
      const stored = await this.findOperation(id);
      assertNotAbandoned(stored);
      const part = nextPart(stored);
      const prior = latestAttempt(stored, part);
      let raw: Hex;
      let expectedHash: Hex;
      if (prior?.rawTransaction) {
        raw = prior.rawTransaction;
        expectedHash = prior.transactionHash;
      } else {
        const tx = await this.completeExternalTx(restoreTx(requiredTx(stored, part)));
        raw = await this.params.signer!.signTransaction(tx);
        expectedHash = keccak256(raw);
        stored.attempts.push({
          part,
          rawTransaction: raw,
          transactionHash: expectedHash,
          submittedAt: Date.now(),
        });
        stored.stage = part === 'funding' ? 'FundingReady' : 'Signed';
        await this.saveOperation(stored);
      }

      const broadcastHash = await this.host.provider.sendRawTransaction(raw);
      if (broadcastHash.toLowerCase() !== expectedHash.toLowerCase()) {
        throw new Error(`RPC returned ${broadcastHash}, expected raw transaction hash ${expectedHash}`);
      }
      const attempt = latestAttempt(stored, part);
      if (attempt) attempt.broadcastAt = Date.now();
      stored.stage = part === 'funding' ? 'FundingSubmitted' : 'Submitted';
      await this.saveOperation(stored);
      return publicOperation(stored);
    });
  }

  async recordSubmission(
    operation: string | PreparedOperation,
    part: OperationPart,
    transactionHash: Hex,
    rawTransaction?: Hex,
  ): Promise<PreparedOperation> {
    const id = typeof operation === 'string' ? operation : operation.id;
    return withStorageLock(this.host.storage, async () => {
      const stored = await this.findOperation(id);
      assertNotAbandoned(stored);
      assertPart(stored, part);
      if (rawTransaction && keccak256(rawTransaction).toLowerCase() !== transactionHash.toLowerCase()) {
        throw new Error('Reported transaction hash does not match raw transaction bytes');
      }
      stored.attempts.push({
        part,
        transactionHash,
        rawTransaction,
        submittedAt: Date.now(),
        broadcastAt: Date.now(),
      });
      stored.stage = part === 'funding' ? 'FundingSubmitted' : 'Submitted';
      await this.saveOperation(stored);
      return publicOperation(stored);
    });
  }

  async recordReplacement(
    operation: string | PreparedOperation,
    part: OperationPart,
    replacedHash: Hex,
    transactionHash: Hex,
    rawTransaction?: Hex,
  ): Promise<PreparedOperation> {
    const id = typeof operation === 'string' ? operation : operation.id;
    return withStorageLock(this.host.storage, async () => {
      const stored = await this.findOperation(id);
      assertNotAbandoned(stored);
      assertPart(stored, part);
      if (!stored.attempts.some((attempt) => attempt.part === part
        && attempt.transactionHash.toLowerCase() === replacedHash.toLowerCase())) {
        throw new Error(`Replacement target ${replacedHash} is not recorded`);
      }
      if (rawTransaction && keccak256(rawTransaction).toLowerCase() !== transactionHash.toLowerCase()) {
        throw new Error('Replacement hash does not match raw transaction bytes');
      }
      stored.attempts.push({
        part,
        transactionHash,
        rawTransaction,
        replaces: replacedHash,
        submittedAt: Date.now(),
        broadcastAt: Date.now(),
      });
      await this.saveOperation(stored);
      return publicOperation(stored);
    });
  }

  async refreshOperations(): Promise<PreparedOperation[]> {
    const ids = (await this.allOperations()).map(({ id }) => id);
    const refreshed: PreparedOperation[] = [];
    for (const id of ids) {
      const observed = await this.observeOperation(id);
      refreshed.push(await withStorageLock(this.host.storage, async () => {
        const operation = await this.findOperation(id);
        reconcileOperation(operation, observed);
        await this.saveOperation(operation);
        if (operation.isChannelOpening && operation.channelKey) {
          await this.reconcileChannelStatus(operation);
        }
        return publicOperation(operation);
      }));
    }
    return refreshed;
  }

  async abandonPreparedOperation(operation: string | PreparedOperation): Promise<void> {
    const id = typeof operation === 'string' ? operation : operation.id;
    await withStorageLock(this.host.storage, async () => {
      const stored = await this.findOperation(id);
      stored.abandoned = true;
      await this.saveOperation(stored);
      if (stored.channelKey) {
        const book = await this.channelBook(stored.scheme);
        const channel = book.channels.find(({ key }) => key === stored.channelKey);
        if (channel && channel.opening.id === stored.id) {
          channel.status = 'abandoned';
          await writeRecord(this.host.storage, this.channelsKey(stored.scheme), book);
        }
      }
    });
  }

  async createScanner(): Promise<BoundScanner> {
    return new BoundScanner(this);
  }

  async prepareSpend(input: PrepareSpendInput): Promise<PreparedOperation> {
    // Refresh holdings first, then retrieve private match material from the storage checkpoint.
    // Neither notes() nor the returned PreparedOperation exposes it.
    await this.notes(undefined, true);
    const note = await this.findStoredNote(input.noteId);
    if (!note || note.spent) throw new Error(`Spendable note ${input.noteId} was not found`);
    const noteAmount = BigInt(note.amount);
    const noteAsset = restoreAsset(note.asset);
    const amount = input.amount ?? noteAmount;
    if (amount <= 0n || amount > noteAmount) throw new Error('Invalid spend amount');
    const gasPrice = await this.host.provider.getGasPrice();
    const maxFeePerGas = input.maxFeePerGas ?? gasPrice * 2n;
    const maxPriorityFeePerGas = input.maxPriorityFeePerGas ?? gasPrice / 10n;
    const defaultGas = noteAsset.__type === 'native' ? 21_000n
      : noteAsset.__type === 'erc20' ? 65_000n : 100_000n;
    const gasLimit = input.gasLimit ?? defaultGas;
    const nativeBalance = await this.host.provider.getBalance(note.address);
    const gasCost = gasLimit * maxFeePerGas;
    if (noteAsset.__type !== 'native' && nativeBalance < gasCost) {
      throw new PQStealthError('InsufficientGas', `Stealth EOA ${note.address} lacks native gas`);
    }
    if (noteAsset.__type === 'native' && nativeBalance < amount + gasCost) {
      throw new PQStealthError('InsufficientGas', 'Native spend amount leaves insufficient gas');
    }
    const intent = await buildAssetTransfer(noteAsset, note.address, input.to, amount, true);
    const operation: StoredOperation = {
      id: operationId('spend', note.scheme, `${note.id}:${Date.now()}`),
      kind: 'spend',
      scheme: note.scheme,
      stage: 'Prepared',
      transactions: {
        spend: storeTx({
          ...intent,
          from: note.address,
          chainId: this.chainId,
          nonce: await this.host.provider.getTransactionCount(note.address),
          gasLimit,
          maxFeePerGas,
          maxPriorityFeePerGas,
          type: 2,
        }),
      },
      attempts: [],
      diagnostics: [],
      abandoned: false,
      createdAt: Date.now(),
      spend: { noteId: note.id, material: note.match },
    };
    await withStorageLock(this.host.storage, async () => {
      const book = await this.operationBook();
      book.operations.push(operation);
      await writeRecord(this.host.storage, this.operationsKey(), book);
    });
    return publicOperation(operation);
  }

  async signPreparedSpend(operation: string | PreparedOperation): Promise<PreparedOperation> {
    const id = typeof operation === 'string' ? operation : operation.id;
    return withStorageLock(this.host.storage, async () => {
      const stored = await this.findOperation(id);
      await this.signSpendLocked(stored);
      return publicOperation(stored);
    });
  }

  async submitPreparedSpend(operation: string | PreparedOperation): Promise<PreparedOperation> {
    const id = typeof operation === 'string' ? operation : operation.id;
    return withStorageLock(this.host.storage, async () => {
      const stored = await this.findOperation(id);
      await this.signSpendLocked(stored);
      const spend = stored.spend;
      if (!spend?.signedRaw || !spend.signedHash) throw new Error('Spend was not signed');
      const raw = spend.signedRaw;
      const hash = await this.host.provider.sendRawTransaction(raw);
      if (hash.toLowerCase() !== spend.signedHash.toLowerCase()) {
        throw new Error(`RPC returned ${hash}, expected raw transaction hash ${spend.signedHash}`);
      }
      const attempt = latestAttempt(stored, 'spend');
      if (attempt) attempt.broadcastAt = Date.now();
      stored.stage = 'Submitted';
      await this.saveOperation(stored);
      return publicOperation(stored);
    });
  }

  async exportTrackingCapability(
    scheme: SchemeKind,
    options: { scannerChannel?: Hex } = {},
  ): Promise<TrackingCapability> {
    const identity = await this.identity(scheme);
    let capability: { capability: string; scheme: SchemeKind; bytes: number[] };
    if (options.scannerChannel) {
      capability = bindings.export_channel_watch(
        scheme,
        hexBytes(options.scannerChannel),
      ) as typeof capability;
    } else {
      capability = bindings.export_tracking_capability(
        identity,
        this.keygenMaster,
      ) as typeof capability;
    }
    return {
      capability: capability.capability,
      scheme: capability.scheme,
      bytes: byteHex(capability.bytes),
    } as TrackingCapability;
  }

  async notes(assets?: AssetId[], includeSpent = false): Promise<PQStealthNote[]> {
    const scanner = await this.createScanner();
    try {
      await scanner.scan();
    } finally {
      await scanner.close();
    }
    const notes: PQStealthNote[] = [];
    for (const scheme of SCHEMES) {
      const checkpoint = await readRecord<ScannerCheckpoint>(this.host.storage, this.scannerKey(scheme))
        ?? emptyCheckpoint();
      notes.push(...checkpoint.current.notes.map(publicNote));
    }
    return notes.filter((note) =>
      (includeSpent || !note.spent)
      && (!assets || assets.some((asset) => assetKey(asset) === assetKey(note.asset))));
  }

  async balance(assets?: AssetId[]): Promise<PQStealthBalance[]> {
    const notes = await this.notes(assets, false);
    const balances = new Map<string, PQStealthBalance>();
    for (const note of notes) {
      const key = assetKey(note.asset);
      const current = balances.get(key);
      if (current) current.amount += note.amount;
      else balances.set(key, { asset: note.asset, amount: note.amount });
    }
    return [...balances.values()];
  }

  private async initializeIdentities(): Promise<void> {
    for (const scheme of SCHEMES) {
      if (await readRecord(this.host.storage, this.identityKey(scheme))) continue;
      await writeRecord(
        this.host.storage,
        this.identityKey(scheme),
        await deriveIdentity(scheme, this.keygenMaster),
      );
    }
  }

  private async initializeSenderState(): Promise<void> {
    const records = await Promise.all(SCHEMES.map((scheme) =>
      readRecord<SenderEntropyRecord>(this.host.storage, this.senderKey(scheme))));
    const present = records.filter(Boolean).length;
    if (this.params.operationalMode === 'recipient-only') return;
    if (this.params.operationalMode === 'resume') {
      if (present !== SCHEMES.length) {
        throw new PQStealthError('MissingOperationalState', 'Resume requires all four sender records');
      }
      return;
    }
    if (present !== 0 && present !== SCHEMES.length) {
      throw new PQStealthError('MissingOperationalState', 'Create refuses partial sender state');
    }
    if (present === 0) {
      for (const scheme of SCHEMES) {
        await writeRecord<SenderEntropyRecord>(this.host.storage, this.senderKey(scheme), {
          scheme,
          nextIndex: '0',
          reservations: [],
        });
      }
    }
  }

  private async recoverReservationsLocked(): Promise<void> {
    if (!this.senderMaster) return;
    for (const scheme of SCHEMES) {
      const sender = await readRecord<SenderEntropyRecord>(this.host.storage, this.senderKey(scheme));
      if (!sender) continue;
      for (const draft of [...sender.reservations]) {
        if (draft.chainId !== this.chainId.toString()) continue;
        try {
          await this.finalizeOrDiscardReservationLocked(sender, draft);
        } catch (error) {
          if (isStorageFailure(error)) throw error;
        }
      }
    }
  }

  private async reserveOpeningLocked(
    input: PaymentInput,
    recipient: ResolvedRecipient,
  ): Promise<StoredOperation> {
    const sender = await readRecord<SenderEntropyRecord>(
      this.host.storage,
      this.senderKey(input.scheme),
    );
    if (!sender || !this.senderMaster) this.requireSender();
    if (input.scheme.endsWith('-channel')) {
      const pending = sender!.reservations.find((draft) =>
        draft.chainId === this.chainId.toString()
        && draft.metaAddress.toLowerCase() === recipient.metaAddress.toLowerCase());
      if (pending) {
        let operation: StoredOperation | undefined;
        try {
          operation = await this.finalizeOrDiscardReservationLocked(sender!, pending);
        } catch (error) {
          if (!isSeedRejected(error)) throw error;
        }
        if (operation) {
          throw new PQStealthError(
            'ChannelOpeningPending',
            `Channel opening is pending: ${operation.id}`,
            operation.id,
          );
        }
      }
    }
    for (;;) {
      const reservation = bindings.SenderReservation.reserve(
        input.scheme,
        this.senderMaster!,
        sender!.nextIndex,
      );
      const draft: ReservationDraft = {
        id: operationId('payment', input.scheme, `${this.chainId}:${reservation.index}`),
        chainId: this.chainId.toString(),
        scheme: input.scheme,
        index: reservation.index,
        metaAddress: recipient.metaAddress,
        payer: input.payer,
        asset: storeAsset(input.asset),
        amount: input.amount.toString(),
        createdAt: Date.now(),
      };
      sender!.nextIndex = reservation.nextIndex;
      sender!.reservations.push(draft);
      // The next-unused index and recoverable reservation marker become durable first.
      await writeRecord(this.host.storage, this.senderKey(input.scheme), sender!);
      try {
        return await this.finalizeOrDiscardReservationLocked(sender!, draft, reservation);
      } catch (error) {
        if (!isSeedRejected(error)) throw error;
      }
    }
  }

  private async finalizeOrDiscardReservationLocked(
    sender: SenderEntropyRecord,
    draft: ReservationDraft,
    reservation?: { complete(metaAddress: Uint8Array): unknown },
  ): Promise<StoredOperation> {
    try {
      return await this.finalizeReservationLocked(sender, draft, reservation);
    } catch (error) {
      if (isStorageFailure(error)) throw error;
      await this.removeReservationLocked(sender, draft);
      throw error;
    }
  }

  private async removeReservationLocked(
    sender: SenderEntropyRecord,
    draft: ReservationDraft,
  ): Promise<void> {
    sender.reservations = sender.reservations.filter(({ id }) => id !== draft.id);
    await writeRecord(this.host.storage, this.senderKey(draft.scheme), sender);
  }

  private async finalizeReservationLocked(
    sender: SenderEntropyRecord,
    draft: ReservationDraft,
    existingReservation?: { complete(metaAddress: Uint8Array): unknown },
  ): Promise<StoredOperation> {
    if (draft.scheme.endsWith('-channel')) {
      const key = channelKey(this.chainId, draft.scheme, draft.metaAddress);
      const book = await this.channelBook(draft.scheme);
      const existing = book.channels.find((channel) => channel.key === key);
      if (existing) {
        await this.removeReservationLocked(sender, draft);
        return existing.opening;
      }
    } else {
      const book = await this.operationBook();
      const existing = book.operations.find((operation) => operation.id === draft.id);
      if (existing) {
        await this.removeReservationLocked(sender, draft);
        return existing;
      }
    }

    const reservation = existingReservation ?? bindings.SenderReservation.reserve(
      draft.scheme,
      this.senderMaster!,
      draft.index,
    );
    const result = reservation.complete(hexBytes(draft.metaAddress)) as ReservationOutput;
    if (!result.announcement) throw new Error('Upstream reservation returned no announcement');
    const input: PaymentInput = {
      recipient: { metaAddress: draft.metaAddress, scheme: draft.scheme },
      scheme: draft.scheme,
      payer: draft.payer,
      asset: restoreAsset(draft.asset),
      amount: BigInt(draft.amount),
    };
    const operation = await this.paymentOperation(
      draft.id,
      input,
      result.announcement,
      draft.createdAt,
    );
    if (draft.scheme.endsWith('-channel')) {
      const key = channelKey(this.chainId, draft.scheme, draft.metaAddress);
      operation.channelKey = key;
      operation.isChannelOpening = true;
      const book = await this.channelBook(draft.scheme);
      const record: ChannelRecord = {
        key,
        metaAddress: draft.metaAddress,
        status: 'opening',
        senderBlob: Array.from(result.sender_channel ?? []),
        opening: operation,
        memos: [],
      };
      book.channels.push(record);
      // Opening bytes, sender role blob, both tx intents, and attempts live in this one record.
      await writeRecord(this.host.storage, this.channelsKey(draft.scheme), book);
    } else {
      const book = await this.operationBook();
      if (!book.operations.some(({ id }) => id === operation.id)) book.operations.push(operation);
      await writeRecord(this.host.storage, this.operationsKey(), book);
    }
    await this.removeReservationLocked(sender, draft);
    return operation;
  }

  private async prepareMemoLocked(
    channel: ChannelRecord,
    book: SenderChannelBook,
    input: PaymentInput,
  ): Promise<StoredOperation> {
    const result = bindings.pay_channel(input.scheme, Uint8Array.from(channel.senderBlob)) as ReservationOutput;
    if (!result.announcement || !result.sender_channel) throw new Error('Upstream memo failed');
    channel.senderBlob = Array.from(result.sender_channel);
    // Persist the advanced sender blob before any later work so a crash cannot reuse the counter.
    await writeRecord(this.host.storage, this.channelsKey(input.scheme), book);
    const operation = await this.paymentOperation(
      operationId('payment', input.scheme, `${channel.key}:${channel.memos.length + 1}`),
      input,
      result.announcement,
      Date.now(),
    );
    operation.channelKey = channel.key;
    channel.memos.push(operation);
    await writeRecord(this.host.storage, this.channelsKey(input.scheme), book);
    return operation;
  }

  private async paymentOperation(
    id: string,
    input: PaymentInput,
    announcement: NonNullable<StoredOperation['announcement']>,
    createdAt: number,
  ): Promise<StoredOperation> {
    const announceData = byteHex(bindings.encode_announce_call(announcement));
    const funding = await buildAssetTransfer(
      input.asset,
      input.payer,
      byteHex(announcement.stealth_address) as Address,
      input.amount,
      false,
    );
    return {
      id,
      kind: 'payment',
      scheme: input.scheme,
      stage: 'Prepared',
      announcement,
      transactions: {
        announcement: storeTx({ to: this.announcerAddress, data: announceData, value: 0n }),
        funding: storeTx({ ...funding, from: input.payer }),
      },
      attempts: [],
      diagnostics: [],
      abandoned: false,
      createdAt,
    };
  }

  private async completeExternalTx(tx: TxRequest): Promise<TxRequest> {
    const signer = this.params.signer!;
    const from = await signer.getAddress() as Address;
    if (tx.from && tx.from.toLowerCase() !== from.toLowerCase()) {
      throw new PQStealthError(
        'SignerMismatch',
        `Configured signer ${from} does not own prepared transaction ${tx.from}`,
      );
    }
    const gasPrice = await this.host.provider.getGasPrice();
    const call = {
      to: tx.to!,
      from,
      input: tx.data,
      value: numberToHex(tx.value ?? 0n),
    };
    return {
      ...tx,
      from,
      chainId: tx.chainId ?? this.chainId,
      nonce: tx.nonce ?? await this.host.provider.getTransactionCount(from),
      gasLimit: tx.gasLimit ?? await this.host.provider.estimateGas(call),
      maxFeePerGas: tx.maxFeePerGas ?? gasPrice * 2n,
      maxPriorityFeePerGas: tx.maxPriorityFeePerGas ?? gasPrice / 10n,
      type: 2,
    };
  }

  private async observeOperation(id: string): Promise<Partial<Record<OperationPart, TransactionReceipt | null>>> {
    const operation = await this.findOperation(id);
    const observed: Partial<Record<OperationPart, TransactionReceipt | null>> = {};
    for (const part of ['registration', 'announcement', 'funding', 'spend'] as const) {
      const attempts = operation.attempts.filter((attempt) => attempt.part === part).reverse();
      if (attempts.length === 0) continue;
      observed[part] = null;
      for (const attempt of attempts) {
        const receipt = await this.host.provider.getTransactionReceipt(attempt.transactionHash);
        if (!receipt) continue;
        const header = await this.host.provider.getBlockHeader(receipt.blockNumber);
        if (header?.hash !== receipt.blockHash) continue;
        if ((part === 'funding' || part === 'spend') && receipt.status === 1n) {
          const verified = await verifyAssetTransferReceipt(
            restoreTx(requiredTx(operation, part)),
            receipt,
          );
          observed[part] = verified ? receipt : { ...receipt, status: 0n };
        } else {
          observed[part] = receipt;
        }
        break;
      }
    }
    return observed;
  }

  private async reconcileChannelStatus(operation: StoredOperation): Promise<void> {
    if (!operation.channelKey) return;
    const book = await this.channelBook(operation.scheme);
    const channel = book.channels.find(({ key }) => key === operation.channelKey);
    if (!channel || channel.opening.id !== operation.id) return;

    let status: ChannelRecord['status'] = 'opening';
    if (channel.status === 'abandoned' || operation.abandoned) {
      status = 'abandoned';
    } else if (operation.stage === 'Complete' && operation.announcementBlock) {
      const latest = await this.host.provider.getBlockNumber();
      if (latest >= BigInt(operation.announcementBlock.number)
        + this.params.deployment.finalityDepth) {
        status = 'active';
      }
    }
    if (channel.status !== status) {
      channel.status = status;
      await writeRecord(this.host.storage, this.channelsKey(operation.scheme), book);
    }
  }

  private async signSpendLocked(stored: StoredOperation): Promise<void> {
    assertNotAbandoned(stored);
    if (stored.kind !== 'spend' || !stored.spend) throw new Error('Operation is not a spend');
    if (stored.spend.signedRaw && stored.spend.signedHash) return;
    const identity = await this.identity(stored.scheme);
    const tx = restoreTx(requiredTx(stored, 'spend'));
    const signed = await signSpend(
      this.keygenMaster,
      identity.accepted_j,
      stored.spend.material,
      tx as Parameters<typeof signSpend>[3],
    );
    if (tx.from?.toLowerCase() !== signed.signer.toLowerCase()) {
      throw new Error(`Internal spend signer ${signed.signer} does not match ${tx.from}`);
    }
    stored.spend.signedRaw = signed.raw;
    stored.spend.signedHash = signed.hash;
    stored.attempts.push({
      part: 'spend',
      transactionHash: signed.hash,
      rawTransaction: signed.raw,
      submittedAt: Date.now(),
    });
    stored.stage = 'Signed';
    await this.saveOperation(stored);
  }

  private async operationBook(): Promise<OperationBook> {
    return await readRecord<OperationBook>(this.host.storage, this.operationsKey())
      ?? { operations: [] };
  }

  private async channelBook(scheme: SchemeKind): Promise<SenderChannelBook> {
    return await readRecord<SenderChannelBook>(this.host.storage, this.channelsKey(scheme))
      ?? { channels: [] };
  }

  private async allOperations(): Promise<StoredOperation[]> {
    const operations = [...(await this.operationBook()).operations];
    for (const scheme of SCHEMES.filter((value) => value.endsWith('-channel'))) {
      for (const channel of (await this.channelBook(scheme)).channels) {
        operations.push(channel.opening, ...channel.memos);
      }
    }
    return operations;
  }

  private async findOperation(id: string): Promise<StoredOperation> {
    const found = (await this.allOperations()).find((operation) => operation.id === id);
    if (!found) throw new Error(`Unknown prepared operation ${id}`);
    return found;
  }

  private async findStoredNote(id: string) {
    for (const scheme of SCHEMES) {
      const checkpoint = await readRecord<ScannerCheckpoint>(
        this.host.storage,
        this.scannerKey(scheme),
      );
      const note = checkpoint?.current.notes.find((candidate) => candidate.id === id);
      if (note) return note;
    }
    return undefined;
  }

  private async saveOperation(operation: StoredOperation): Promise<void> {
    const book = await this.operationBook();
    const ordinary = book.operations.findIndex(({ id }) => id === operation.id);
    if (ordinary !== -1) {
      book.operations[ordinary] = operation;
      await writeRecord(this.host.storage, this.operationsKey(), book);
      return;
    }
    const channels = await this.channelBook(operation.scheme);
    for (const channel of channels.channels) {
      if (channel.opening.id === operation.id) {
        channel.opening = operation;
        await writeRecord(this.host.storage, this.channelsKey(operation.scheme), channels);
        return;
      }
      const memo = channel.memos.findIndex(({ id }) => id === operation.id);
      if (memo !== -1) {
        channel.memos[memo] = operation;
        await writeRecord(this.host.storage, this.channelsKey(operation.scheme), channels);
        return;
      }
    }
    throw new Error(`Could not save unknown operation ${operation.id}`);
  }

  private requireSender(): void {
    if (!this.senderMaster || this.params.operationalMode === 'recipient-only') {
      throw new PQStealthError(
        'MissingOperationalState',
        'Sending requires an exact operational backup or an explicitly new accountIndex',
      );
    }
  }

  private identityKey(scheme: SchemeKind): string {
    return `${this.baseKey}:identity:${scheme}`;
  }

  private senderKey(scheme: SchemeKind): string {
    // Deliberately no chain id: sender entropy is global for (accountIndex, scheme).
    return `${this.baseKey}:sender:${scheme}`;
  }

  private operationsKey(): string {
    return `${this.baseKey}:chain:${this.chainId}:operations`;
  }

  private channelsKey(scheme: SchemeKind): string {
    return `${this.baseKey}:chain:${this.chainId}:channels:${scheme}`;
  }
}

export type PQStealthPluginInternal = PQStealthProtocol;

export const createPQStealthPlugin: CreatePluginFn<
  PQStealthInstance,
  PQStealthPluginParams
> = (host, params) => PQStealthProtocol.create(host, params);

function validateParams(params: PQStealthPluginParams): void {
  if (!Number.isSafeInteger(params.accountIndex)
    || params.accountIndex < 0
    || params.accountIndex > 0x7fff_ffff) {
    throw new Error('accountIndex must fit a hardened BIP-32 child index');
  }
  if (params.deployment.announcerStartBlock < 0n || params.deployment.finalityDepth < 0n) {
    throw new Error('Block configuration cannot be negative');
  }
  const lookahead = params.lookahead ?? DEFAULT_LOOKAHEAD;
  if (!Number.isInteger(lookahead) || lookahead < 1 || lookahead > 65_536) {
    throw new Error('lookahead must be in pqsa range 1..=65536');
  }
  const batch = params.deployment.scanBatchSize ?? DEFAULT_SCAN_BATCH_SIZE;
  if (!Number.isSafeInteger(batch) || batch < 1) throw new Error('scanBatchSize must be positive');
}

function operationId(kind: string, scheme: SchemeKind, entropy: string): string {
  return keccak256(stringToHex(`pq-stealth:v1:${kind}:${scheme}:${entropy}`));
}

function channelKey(chainId: bigint, scheme: SchemeKind, metaAddress: Hex): Hex {
  return keccak256(stringToHex(`${chainId}:${scheme}:${keccak256(metaAddress)}`));
}

function nextPart(operation: StoredOperation): OperationPart {
  if (operation.kind === 'registration') return 'registration';
  if (operation.kind === 'spend') return 'spend';
  if (operation.stage === 'FundingReady' || operation.stage === 'FundingSubmitted') return 'funding';
  return 'announcement';
}

function requiredTx(operation: StoredOperation, part: OperationPart) {
  const tx = operation.transactions[part];
  if (!tx) throw new Error(`Operation ${operation.id} has no ${part} transaction`);
  return tx;
}

function assertPart(operation: StoredOperation, part: OperationPart): void {
  requiredTx(operation, part);
  if (operation.kind === 'payment' && part === 'funding'
    && operation.stage !== 'FundingReady' && operation.stage !== 'FundingSubmitted') {
    throw new PQStealthError('InvalidOperationState', 'Funding is not ready');
  }
}

function assertNotAbandoned(operation: StoredOperation): void {
  if (operation.abandoned) {
    throw new PQStealthError(
      'InvalidOperationState',
      `Operation ${operation.id} was abandoned`,
      operation.id,
    );
  }
}

function isSeedRejected(error: unknown): boolean {
  return /seed.?rejected/i.test(String(error));
}

function isStorageFailure(error: unknown): boolean {
  return error instanceof PQStealthError && error.code === 'StorageFailure';
}

function latestAttempt(operation: StoredOperation, part: OperationPart) {
  return [...operation.attempts].reverse().find((attempt) => attempt.part === part);
}

function reconcileOperation(
  operation: StoredOperation,
  observed: Partial<Record<OperationPart, TransactionReceipt | null>>,
): void {
  const primaryPart = operation.kind === 'registration' ? 'registration'
    : operation.kind === 'spend' ? 'spend' : 'announcement';
  const primaryAttempt = latestAttempt(operation, primaryPart);
  const fundingAttempt = latestAttempt(operation, 'funding');
  operation.stage = bindings.reconcile_operation_stage(operation.kind, {
    primary_attempt: primaryAttempt != null,
    primary_broadcast: primaryAttempt?.broadcastAt != null,
    primary_success: observed[primaryPart]?.status === 1n,
    funding_attempt: fundingAttempt != null,
    funding_broadcast: fundingAttempt?.broadcastAt != null,
    funding_success: observed.funding?.status === 1n,
  });
  if (operation.kind !== 'payment') {
    return;
  }
  const announcement = observed.announcement;
  const funding = observed.funding;
  if (!announcement || announcement.status !== 1n) {
    operation.announcementBlock = undefined;
    operation.fundingBlock = undefined;
    return;
  }
  operation.announcementBlock = {
    number: announcement.blockNumber.toString(),
    hash: announcement.blockHash,
  };
  if (funding?.status === 1n) {
    operation.fundingBlock = { number: funding.blockNumber.toString(), hash: funding.blockHash };
  } else {
    operation.fundingBlock = undefined;
  }
}
