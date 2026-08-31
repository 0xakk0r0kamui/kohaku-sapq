import type { CreatePluginFn, Host } from '@kohaku-eth/plugins';
import { keccak256, type Hex } from 'viem';
import { sameAsset } from './assets.js';
import {
  registrationTransaction,
  resolveRecipient,
} from './recipient.js';
import { scanNotes } from './scanner.js';
import { initializeSender, preparePayment } from './sender.js';
import { preparePlugin, type PluginContext } from './setup.js';
import {
  prepareSpend,
  submitSpend,
} from './spending.js';
import type {
  Asset,
  Balance,
  Identity,
  Note,
  PaymentInput,
  PluginParams,
  PreparedPayment,
  Recipient,
  Scheme3Instance,
  SignedSpend,
  SpendInput,
} from './types.js';

class Plugin implements Scheme3Instance {
  readonly host: Host;
  readonly params: PluginParams;
  readonly chainId: bigint;
  readonly #account: Identity;
  readonly #keygenMaster: Uint8Array;
  readonly #senderMaster?: Uint8Array;

  private constructor(host: Host, context: PluginContext) {
    this.host = host;
    this.params = context.params;
    this.chainId = context.chainId;
    this.#account = context.account;
    this.#keygenMaster = context.keygenMaster;
    this.#senderMaster = context.senderMaster;
  }

  /** Derive keys from the host and set up sender state. */
  static async create(
    host: Host,
    params: PluginParams,
  ): Promise<Plugin> {
    const plugin = new Plugin(host, await preparePlugin(host, params));

    await initializeSender(host, plugin.params.mode, plugin.senderKey());

    return plugin;
  }

  identity(): Identity {
    return { ...this.#account };
  }

  async instanceId(): Promise<`pqsa3:${Hex}`> {
    return `pqsa3:${keccak256(this.#account.metaAddress)}`;
  }

  registrationTransaction() {
    return registrationTransaction(
      this.params.deployment.registry,
      this.#account.metaAddress,
    );
  }

  async resolveRecipient(recipient: Recipient): Promise<Hex> {
    return resolveRecipient(this.host, this.params.deployment.registry, recipient);
  }

  /** Build unsigned announce and fund transactions. */
  async preparePayment(input: PaymentInput): Promise<PreparedPayment> {
    if (!this.#senderMaster) throw new Error('This plugin instance is receive-only');

    const metaAddress = await this.resolveRecipient(input.recipient);

    return preparePayment(
      this.host,
      this.params.deployment.announcer,
      this.senderKey(),
      this.#senderMaster,
      metaAddress,
      input,
    );
  }

  /** Scan announcer logs and update balances. */
  async scan(): Promise<Note[]> {
    return scanNotes(
      this.host,
      this.params,
      this.#account,
      this.#keygenMaster,
      this.scanKey(),
    );
  }

  async notes(
    assets?: readonly Asset[],
    includeSpent = false,
  ): Promise<Note[]> {
    const notes = await this.scan();

    return notes.filter((note) =>
      (includeSpent || !note.spent)
      && (assets === undefined || assets.some((asset) => sameAsset(asset, note.asset))));
  }

  async balance(assets?: readonly Asset[]): Promise<Balance[]> {
    const requested = assets ?? this.params.assets;
    const notes = await this.notes(requested, false);

    return requested.map((asset) => ({
      asset,
      amount: notes
        .filter((note) => sameAsset(note.asset, asset))
        .reduce((total, note) => total + note.amount, 0n),
    }));
  }

  /** Sign a spend from a scanned note. */
  async prepareSpend(input: SpendInput): Promise<SignedSpend> {
    return prepareSpend(
      this.host,
      this.chainId,
      this.#keygenMaster,
      this.#account,
      this.scanKey(),
      input,
    );
  }

  async submitSpend(spend: SignedSpend): Promise<Hex> {
    return submitSpend(this.host, spend);
  }

  private storagePrefix(): string {
    return `pqsa3:v1:${keccak256(this.#account.metaAddress)}`;
  }

  private senderKey(): string {
    return `${this.storagePrefix()}:sender`;
  }

  private scanKey(): string {
    const announcer = this.params.deployment.announcer.toLowerCase();

    return `${this.storagePrefix()}:chain:${this.chainId}:announcer:${announcer}:scan`;
  }
}

export const createScheme3Plugin: CreatePluginFn<Scheme3Instance, PluginParams>
  = (host, params) => Plugin.create(host, params);
