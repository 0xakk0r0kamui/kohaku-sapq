// Sender counter and scan, with a stub provider.
import { MemoryStorage, MnemonicKeystore, type Host } from '@kohaku-eth/plugins';
import {
  encodeAbiParameters,
  encodeEventTopics,
  hexToBytes,
  keccak256,
  type Address,
  type Hex,
} from 'viem';
import { describe, expect, it, vi } from 'vitest';
import { ANNOUNCER_ABI } from '../sdk/abi.js';
import { createScheme3Plugin } from '../sdk/index.js';
import type { PreparedPayment, Scheme3Instance } from '../sdk/types.js';

const announcer = `0x${'11'.repeat(20)}` as Address;
const registry = `0x${'22'.repeat(20)}` as Address;
const caller = `0x${'33'.repeat(20)}` as Address;
const mnemonic = 'test test test test test test test test test test test junk';

function createHost() {
  const logs: Array<{
    blockNumber: bigint;
    address: Address;
    topics: Hex[];
    data: Hex;
  }> = [];
  const storage = new MemoryStorage();
  const provider = {
    getChainId: vi.fn(async () => 1n),
    getCode: vi.fn(async () => '0x01'),
    getBlockNumber: vi.fn(async () => 10n),
    getLogs: vi.fn(async () => logs),
    getBalance: vi.fn(async () => 7n),
    call: vi.fn(),
  };
  const host = {
    storage,
    provider,
    network: { fetch: globalThis.fetch.bind(globalThis) },
    keystore: new MnemonicKeystore(mnemonic),
  } as unknown as Host;

  return { host, logs, provider, storage };
}

function announcementLog(payment: PreparedPayment) {
  return {
    blockNumber: 5n,
    address: announcer,
    topics: encodeEventTopics({
      abi: ANNOUNCER_ABI,
      eventName: 'Announcement',
      args: {
        schemeId: 3n,
        stealthAddress: payment.announcement.stealthAddress,
        caller,
      },
    }) as Hex[],
    data: encodeAbiParameters(
      [{ type: 'bytes' }, { type: 'bytes' }],
      [payment.announcement.ephemeralPublicKey, payment.announcement.metadata],
    ),
  };
}

async function storedSender(storage: MemoryStorage, plugin: Scheme3Instance) {
  return JSON.parse((await storage.get(senderKey(plugin)))!);
}

async function storedScan(storage: MemoryStorage, plugin: Scheme3Instance) {
  return JSON.parse((await storage.get(scanKey(plugin)))!);
}

function senderKey(plugin: Scheme3Instance) {
  return `${storagePrefix(plugin)}:sender`;
}

function scanKey(plugin: Scheme3Instance) {
  const deployed = plugin.params.deployment.announcer.toLowerCase();

  return `${storagePrefix(plugin)}:chain:1:announcer:${deployed}:scan`;
}

function storagePrefix(plugin: Scheme3Instance) {
  return `pqsa3:v1:${keccak256(plugin.identity().metaAddress)}`;
}

describe('scheme 3 plugin', () => {
  it('persists the sender counter before producing unique announcements', async () => {
    const { host, storage } = createHost();
    const config = params('create');
    const plugin = await createScheme3Plugin(host, config);
    const recipient = { metaAddress: plugin.identity().metaAddress };

    config.assets.length = 0;
    expect(plugin.params.assets).toHaveLength(1);
    expect(Object.isFrozen(plugin.params.deployment)).toBe(true);
    expect('keygenMaster' in plugin).toBe(false);
    expect('senderMaster' in plugin).toBe(false);

    const [first, second] = await Promise.all([
      plugin.preparePayment({
        recipient,
        asset: { __type: 'native' },
        amount: 1n,
      }),
      plugin.preparePayment({
        recipient,
        asset: { __type: 'native' },
        amount: 1n,
      }),
    ]);
    const nextIndex = (await storedSender(storage, plugin)).value.nextIndex;

    console.log('stealth address 1', first.announcement.stealthAddress);
    console.log('stealth address 2', second.announcement.stealthAddress);
    console.log('ephemeral pubkey bytes', (first.announcement.ephemeralPublicKey.length - 2) / 2);
    console.log('metadata bytes', (first.announcement.metadata.length - 2) / 2);
    console.log('sender next index', nextIndex);

    expect(first.announcement.stealthAddress).not.toBe(second.announcement.stealthAddress);
    expect(first.announcement.ephemeralPublicKey).toHaveLength(68);
    expect(first.announcement.metadata).toHaveLength(2 + 1_089 * 2);
    expect(nextIndex).toBe('2');

    const resumed = await createScheme3Plugin(host, params('resume'));

    expect(resumed.identity()).toEqual(plugin.identity());
    const third = await resumed.preparePayment({
      recipient,
      asset: { __type: 'native' },
      amount: 1n,
    });

    console.log('stealth address 3', third.announcement.stealthAddress);

    expect([first.announcement.stealthAddress, second.announcement.stealthAddress])
      .not.toContain(third.announcement.stealthAddress);
  });

  it('decodes an ERC-5564 log, scans it in WASM and keeps the shared secret private', async () => {
    const { host, logs, provider, storage } = createHost();
    const plugin = await createScheme3Plugin(host, params('create'));
    const payment = await plugin.preparePayment({
      recipient: { metaAddress: plugin.identity().metaAddress },
      asset: { __type: 'native' },
      amount: 7n,
    });

    logs.push(announcementLog(payment));

    const notes = await plugin.scan();
    const note = notes[0]!;
    const state = await storedScan(storage, plugin);
    const storedSecret = hexToBytes(state.value.matches[0].sharedSecret);

    console.log('scanned address', note.address);
    console.log('scanned amount', note.amount.toString());
    console.log('note has sharedSecret', 'sharedSecret' in note);
    console.log('stored shared secret bytes', storedSecret.length);

    expect(notes).toHaveLength(1);
    expect(note).toMatchObject({
      address: payment.announcement.stealthAddress,
      amount: 7n,
      spent: false,
    });
    expect('sharedSecret' in note).toBe(false);
    expect(provider.getLogs).toHaveBeenCalledWith(expect.objectContaining({
      topics: expect.any(Array),
    }));
    expect(storedSecret).toHaveLength(32);
  });
});

function params(mode: 'create' | 'resume') {
  return {
    accountIndex: 4,
    mode,
    assets: [{ __type: 'native' as const }],
    deployment: {
      announcer,
      registry,
      announcerStartBlock: 0n,
      finalityDepth: 0n,
      rescanBlocks: 2n,
    },
  };
}
