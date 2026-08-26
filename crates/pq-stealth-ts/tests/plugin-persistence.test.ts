import type { Host, Storage } from '@kohaku-eth/plugins';
import type { EthereumProvider, Hex, TransactionReceipt } from '@kohaku-eth/provider';
import { keccak256 } from 'viem';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PQStealthProtocol } from '../sdk/plugin.js';
import {
  emptyCheckpoint,
  readRecord,
  writeRecord,
  type ScannerCheckpoint,
  type SenderEntropyRecord,
} from '../sdk/storage.js';
import { bindings, byteHex } from '../sdk/wasm.js';

const createTestPlugin = PQStealthProtocol.create;

class TestStorage implements Storage {
  readonly _brand = 'Storage' as const;
  readonly values = new Map<string, string>();
  failNextSet = false;
  setsUntilFailure?: number;
  async set(key: string, value: string) {
    if (this.failNextSet || this.setsUntilFailure === 1) {
      this.failNextSet = false;
      this.setsUntilFailure = undefined;
      throw new Error('fault-injected set failure');
    }
    if (this.setsUntilFailure) this.setsUntilFailure -= 1;
    this.values.set(key, value);
  }
  async get(key: string) { return this.values.get(key) ?? null; }
}

type ChainState = {
  latest: bigint;
  receipts: Map<Hex, TransactionReceipt>;
  blockHashes: Map<bigint, Hex>;
};

function provider(chainId: bigint, state?: ChainState): EthereumProvider {
  return {
    _internal: null,
    getChainId: async () => chainId,
    getLogs: async () => [],
    getBlockNumber: async () => state?.latest ?? 100n,
    getBlockHeader: async (block = 'latest') => ({
      number: typeof block === 'bigint' ? block : (state?.latest ?? 100n),
      hash: state?.blockHashes.get(
        typeof block === 'bigint' ? block : (state?.latest ?? 100n),
      ) ?? `0x${'11'.repeat(32)}`,
      parentHash: `0x${'22'.repeat(32)}`,
    }),
    waitForTransaction: async () => undefined,
    getBalance: async () => 0n,
    getCode: async () => '0x01',
    getTransactionReceipt: async (hash) => state?.receipts.get(hash as Hex) ?? null,
    sendRawTransaction: async () => `0x${'33'.repeat(32)}`,
    request: async () => undefined,
    call: async () => undefined,
    estimateGas: async () => 21_000n,
    getGasPrice: async () => 1n,
    getTransactionCount: async () => 0,
  };
}

function host(storage: TestStorage, chainId: bigint, state?: ChainState): Host {
  return {
    storage,
    provider: provider(chainId, state),
    keystore: {
      deriveAt: async (path) => path.endsWith("/0'")
        ? `0x${'01'.repeat(32)}`
        : `0x${'02'.repeat(32)}`,
    },
    network: { fetch },
  };
}

function receipt(hash: Hex, blockNumber: bigint, blockHash: Hex): TransactionReceipt {
  return {
    blockNumber,
    blockHash,
    transactionHash: hash,
    transactionIndex: 0n,
    from: `0x${'10'.repeat(20)}`,
    to: `0x${'20'.repeat(20)}`,
    contractAddress: null,
    status: 1n,
    logs: [],
    gasUsed: 21_000n,
    cumulativeGasUsed: 21_000n,
    effectiveGasPrice: 1n,
  };
}

function params(mode: 'create' | 'resume' | 'recipient-only') {
  return {
    accountIndex: 7,
    operationalMode: mode,
    deployment: { announcerStartBlock: 0n, finalityDepth: 2n },
  } as const;
}

describe('sender persistence and channel guards', () => {
  afterEach(() => vi.restoreAllMocks());

  it('serializes concurrent and cross-chain draws through one global scheme counter', async () => {
    const storage = new TestStorage();
    const chainOne = await createTestPlugin(host(storage, 1n), params('create'));
    const identity = await chainOne.identity('mlkem-per-payment');
    const recipient = { metaAddress: byteHex(identity.meta_address), scheme: 'mlkem-per-payment' as const };
    const [first, second] = await Promise.all([
      chainOne.preparePayment({
        recipient,
        scheme: 'mlkem-per-payment',
        payer: `0x${'10'.repeat(20)}`,
        asset: { __type: 'native' },
        amount: 1n,
      }),
      chainOne.preparePayment({
        recipient,
        scheme: 'mlkem-per-payment',
        payer: `0x${'10'.repeat(20)}`,
        asset: { __type: 'native' },
        amount: 1n,
      }),
    ]);
    const chainTwo = await createTestPlugin(host(storage, 2n), params('resume'));
    expect(await chainTwo.instanceId()).toBe(await chainOne.instanceId());
    const third = await chainTwo.preparePayment({
      recipient,
      scheme: 'mlkem-per-payment',
      payer: `0x${'10'.repeat(20)}`,
      asset: { __type: 'native' },
      amount: 1n,
    });
    expect(new Set([first.id, second.id, third.id]).size).toBe(3);
    const senderRaw = storage.values.get('pq-stealth:v1:7:sender:mlkem-per-payment')!;
    expect(JSON.parse(senderRaw).value.nextIndex).toBe('3');
  }, 30_000);

  it('blocks duplicate channel openings and recipient-only sending', async () => {
    const storage = new TestStorage();
    const plugin = await createTestPlugin(host(storage, 1n), params('create'));
    const identity = await plugin.identity('mlkem-channel');
    const input = {
      recipient: { metaAddress: byteHex(identity.meta_address), scheme: 'mlkem-channel' as const },
      scheme: 'mlkem-channel' as const,
      payer: `0x${'10'.repeat(20)}` as const,
      asset: { __type: 'native' as const },
      amount: 1n,
    };
    const opening = await plugin.preparePayment(input);
    await expect(plugin.preparePayment(input)).rejects.toMatchObject({
      code: 'ChannelOpeningPending',
      details: opening.id,
    });

    const readonly = await createTestPlugin(host(new TestStorage(), 1n), params('recipient-only'));
    await expect(readonly.preparePayment(input)).rejects.toMatchObject({
      code: 'MissingOperationalState',
    });
  }, 30_000);

  it('blocks managed and external submission after abandonment', async () => {
    const storage = new TestStorage();
    const managedHost = host(storage, 1n);
    const signer = {
      getAddress: vi.fn(async () => `0x${'10'.repeat(20)}`),
      signTransaction: vi.fn(async () => '0x02c0' as const),
    };
    managedHost.provider.sendRawTransaction = vi.fn(async () => keccak256('0x02c0'));
    const plugin = await createTestPlugin(managedHost, { ...params('create'), signer });
    const identity = await plugin.identity('mlkem-per-payment');
    const operation = await plugin.preparePayment({
      recipient: {
        metaAddress: byteHex(identity.meta_address),
        scheme: 'mlkem-per-payment',
      },
      scheme: 'mlkem-per-payment',
      payer: `0x${'10'.repeat(20)}`,
      asset: { __type: 'native' },
      amount: 1n,
    });

    await plugin.abandonPreparedOperation(operation);
    await expect(plugin.submitPreparedOperation(operation)).rejects.toMatchObject({
      code: 'InvalidOperationState',
    });
    await expect(plugin.recordSubmission(
      operation,
      'announcement',
      `0x${'31'.repeat(32)}`,
    )).rejects.toMatchObject({ code: 'InvalidOperationState' });
    expect(signer.signTransaction).not.toHaveBeenCalled();
    expect(managedHost.provider.sendRawTransaction).not.toHaveBeenCalled();
  }, 30_000);

  it('moves chain state backward on reorg without changing announcement bytes or entropy', async () => {
    const storage = new TestStorage();
    const state: ChainState = { latest: 100n, receipts: new Map(), blockHashes: new Map() };
    const plugin = await createTestPlugin(host(storage, 1n, state), params('create'));
    const identity = await plugin.identity('hybrid-per-payment');
    const operation = await plugin.preparePayment({
      recipient: {
        metaAddress: byteHex(identity.meta_address),
        scheme: 'hybrid-per-payment',
      },
      scheme: 'hybrid-per-payment',
      payer: `0x${'10'.repeat(20)}`,
      asset: { __type: 'native' },
      amount: 3n,
    });
    const exactAnnouncement = JSON.stringify(operation.announcement);
    const announcementHash = `0x${'a1'.repeat(32)}` as const;
    const replacementHash = `0x${'a2'.repeat(32)}` as const;
    const fundingHash = `0x${'b2'.repeat(32)}` as const;
    const announcementBlockHash = `0x${'c3'.repeat(32)}` as const;
    const fundingBlockHash = `0x${'d4'.repeat(32)}` as const;
    state.blockHashes.set(90n, announcementBlockHash);
    state.blockHashes.set(91n, fundingBlockHash);

    await plugin.recordSubmission(operation, 'announcement', announcementHash);
    const replaced = await plugin.recordReplacement(
      operation,
      'announcement',
      announcementHash,
      replacementHash,
    );
    expect(replaced.attempts.at(-1)?.replaces).toBe(announcementHash);
    state.receipts.set(
      announcementHash,
      receipt(announcementHash, 90n, announcementBlockHash),
    );
    expect((await plugin.refreshOperations()).find(({ id }) => id === operation.id)?.stage)
      .toBe('FundingReady');
    await plugin.recordSubmission(operation, 'funding', fundingHash);
    state.receipts.set(fundingHash, receipt(fundingHash, 91n, fundingBlockHash));
    expect((await plugin.refreshOperations()).find(({ id }) => id === operation.id)?.stage)
      .toBe('Complete');

    state.receipts.delete(announcementHash);
    const reorged = (await plugin.refreshOperations()).find(({ id }) => id === operation.id)!;
    expect(reorged.stage).toBe('Submitted');
    expect(JSON.stringify(reorged.announcement)).toBe(exactAnnouncement);
    const sender = JSON.parse(
      storage.values.get('pq-stealth:v1:7:sender:hybrid-per-payment')!,
    );
    expect(sender.value.nextIndex).toBe('1');
  }, 30_000);

  it('recovers after broadcast succeeds but status persistence crashes without re-signing', async () => {
    const storage = new TestStorage();
    const state: ChainState = { latest: 90n, receipts: new Map(), blockHashes: new Map() };
    const managedHost = host(storage, 1n, state);
    const raw = '0x02c0' as const;
    const hash = keccak256(raw);
    const signer = {
      getAddress: vi.fn(async () => `0x${'10'.repeat(20)}`),
      signTransaction: vi.fn(async () => raw),
    };
    managedHost.provider.sendRawTransaction = vi.fn(async () => {
      const blockHash = `0x${'ab'.repeat(32)}` as const;
      state.blockHashes.set(90n, blockHash);
      state.receipts.set(hash, receipt(hash, 90n, blockHash));
      storage.failNextSet = true;
      return hash;
    });
    const plugin = await createTestPlugin(managedHost, {
      ...params('create'),
      signer,
    });
    const identity = await plugin.identity('mlkem-per-payment');
    const operation = await plugin.preparePayment({
      recipient: {
        metaAddress: byteHex(identity.meta_address),
        scheme: 'mlkem-per-payment',
      },
      scheme: 'mlkem-per-payment',
      payer: `0x${'10'.repeat(20)}`,
      asset: { __type: 'native' },
      amount: 1n,
    });

    await expect(plugin.submitPreparedOperation(operation)).rejects.toMatchObject({
      code: 'StorageFailure',
    });
    const persisted = (await plugin.pendingOperations()).find(({ id }) => id === operation.id)!;
    expect(persisted.stage).toBe('Signed');
    expect(persisted.attempts[0]).toMatchObject({
      transactionHash: hash,
      rawTransaction: raw,
    });
    expect(persisted.attempts[0]?.broadcastAt).toBeUndefined();
    expect(signer.signTransaction).toHaveBeenCalledTimes(1);

    const recovered = (await plugin.refreshOperations()).find(({ id }) => id === operation.id)!;
    expect(recovered.stage).toBe('FundingReady');
    expect(signer.signTransaction).toHaveBeenCalledTimes(1);
  }, 30_000);

  it('keeps channel memos disabled until opening funding is mined and first contact finalized', async () => {
    const storage = new TestStorage();
    const state: ChainState = { latest: 91n, receipts: new Map(), blockHashes: new Map() };
    const plugin = await createTestPlugin(host(storage, 1n, state), params('create'));
    const identity = await plugin.identity('hybrid-channel');
    const input = {
      recipient: { metaAddress: byteHex(identity.meta_address), scheme: 'hybrid-channel' as const },
      scheme: 'hybrid-channel' as const,
      payer: `0x${'10'.repeat(20)}` as const,
      asset: { __type: 'native' as const },
      amount: 1n,
    };
    const opening = await plugin.preparePayment(input);
    const announcementHash = `0x${'e1'.repeat(32)}` as const;
    const fundingHash = `0x${'e2'.repeat(32)}` as const;
    const announcementBlockHash = `0x${'e3'.repeat(32)}` as const;
    const fundingBlockHash = `0x${'e4'.repeat(32)}` as const;
    state.blockHashes.set(90n, announcementBlockHash);
    state.blockHashes.set(91n, fundingBlockHash);
    state.receipts.set(
      announcementHash,
      receipt(announcementHash, 90n, announcementBlockHash),
    );
    await plugin.recordSubmission(opening, 'announcement', announcementHash);
    await plugin.refreshOperations();
    await plugin.recordSubmission(opening, 'funding', fundingHash);
    state.receipts.set(fundingHash, receipt(fundingHash, 91n, fundingBlockHash));
    await plugin.refreshOperations();
    await expect(plugin.preparePayment(input)).rejects.toMatchObject({
      code: 'ChannelOpeningPending',
    });

    state.latest = 92n;
    await plugin.refreshOperations();
    const memo = await plugin.preparePayment(input);
    expect(memo.id).not.toBe(opening.id);
    expect(memo.isChannelOpening).toBeUndefined();
    const resumed = await createTestPlugin(host(storage, 1n, state), params('resume'));
    const nextMemo = await resumed.preparePayment(input);
    expect(nextMemo.id).not.toBe(memo.id);
    expect(nextMemo.announcement?.stealth_address)
      .not.toEqual(memo.announcement?.stealth_address);

    state.receipts.delete(announcementHash);
    await resumed.refreshOperations();
    await expect(resumed.preparePayment(input)).rejects.toMatchObject({
      code: 'ChannelOpeningPending',
    });

    state.receipts.set(announcementHash, receipt(announcementHash, 90n, announcementBlockHash));
    await resumed.refreshOperations();
    await resumed.abandonPreparedOperation(opening);
    const abandoned = storage.values.get(
      'pq-stealth:v1:7:chain:1:channels:hybrid-channel',
    );
    expect(JSON.parse(abandoned!).value.channels[0].memos).toHaveLength(2);
    await expect(resumed.preparePayment(input)).rejects.toMatchObject({
      code: 'InvalidOperationState',
    });
    expect(storage.values.get('pq-stealth:v1:7:chain:1:channels:hybrid-channel'))
      .toBe(abandoned);
  }, 30_000);

  it('burns a channel memo counter before later failures so restart cannot reuse it', async () => {
    const storage = new TestStorage();
    const state: ChainState = { latest: 92n, receipts: new Map(), blockHashes: new Map() };
    const plugin = await createTestPlugin(host(storage, 1n, state), params('create'));
    const identity = await plugin.identity('hybrid-channel');
    const input = {
      recipient: { metaAddress: byteHex(identity.meta_address), scheme: 'hybrid-channel' as const },
      scheme: 'hybrid-channel' as const,
      payer: `0x${'10'.repeat(20)}` as const,
      asset: { __type: 'native' as const },
      amount: 1n,
    };
    const opening = await plugin.preparePayment(input);
    const announcementHash = `0x${'f1'.repeat(32)}` as const;
    const fundingHash = `0x${'f2'.repeat(32)}` as const;
    const announcementBlockHash = `0x${'f3'.repeat(32)}` as const;
    const fundingBlockHash = `0x${'f4'.repeat(32)}` as const;
    state.blockHashes.set(90n, announcementBlockHash);
    state.blockHashes.set(91n, fundingBlockHash);
    state.receipts.set(announcementHash, receipt(announcementHash, 90n, announcementBlockHash));
    await plugin.recordSubmission(opening, 'announcement', announcementHash);
    await plugin.refreshOperations();
    await plugin.recordSubmission(opening, 'funding', fundingHash);
    state.receipts.set(fundingHash, receipt(fundingHash, 91n, fundingBlockHash));
    await plugin.refreshOperations();

    await expect(plugin.preparePayment({
      ...input,
      asset: { __type: 'erc721', contract: `0x${'33'.repeat(20)}`, tokenId: 1n },
      amount: 2n,
    })).rejects.toThrow(/amount.*(one|1)/i);

    const crashed = JSON.parse(
      storage.values.get('pq-stealth:v1:7:chain:1:channels:hybrid-channel')!,
    ) as { value: { channels: Array<{ senderBlob: number[]; memos: unknown[] }> } };
    expect(crashed.value.channels[0]?.memos).toEqual([]);
    const burnedBlob = crashed.value.channels[0]?.senderBlob;
    expect(burnedBlob).toBeDefined();

    const recovered = await plugin.preparePayment(input);
    const resumed = JSON.parse(
      storage.values.get('pq-stealth:v1:7:chain:1:channels:hybrid-channel')!,
    ) as { value: { channels: Array<{ senderBlob: number[] }> } };
    expect(resumed.value.channels[0]?.senderBlob).not.toEqual(burnedBlob);
    expect(recovered.announcement).toBeDefined();
  }, 30_000);

  it('keeps the old aggregate checkpoint when scan persistence fails', async () => {
    const storage = new TestStorage();
    const state: ChainState = { latest: 10n, receipts: new Map(), blockHashes: new Map() };
    state.blockHashes.set(8n, `0x${'81'.repeat(32)}`);
    const plugin = await createTestPlugin(host(storage, 1n, state), params('create'));
    const key = 'pq-stealth:v1:7:chain:1:scanner:mlkem-per-payment';
    const prior = emptyCheckpoint();
    prior.current.cursor = { number: '8', hash: `0x${'81'.repeat(32)}` };
    prior.finalized.cursor = { number: '8', hash: `0x${'81'.repeat(32)}` };
    await writeRecord(storage, key, prior);
    storage.failNextSet = true;
    const scanner = await plugin.createScanner();
    try {
      await expect(scanner.scan()).rejects.toMatchObject({ code: 'StorageFailure' });
    } finally {
      await scanner.close();
    }

    await expect(readRecord<ScannerCheckpoint>(storage, key)).resolves.toEqual(prior);
  }, 30_000);

  it('rewinds a scanner checkpoint whose finalized cursor hash is no longer canonical', async () => {
    const storage = new TestStorage();
    const state: ChainState = { latest: 10n, receipts: new Map(), blockHashes: new Map() };
    state.blockHashes.set(8n, `0x${'82'.repeat(32)}`);
    const plugin = await createTestPlugin(host(storage, 1n, state), params('create'));
    const key = 'pq-stealth:v1:7:chain:1:scanner:mlkem-per-payment';
    const prior = emptyCheckpoint();
    prior.finalized.cursor = { number: '8', hash: `0x${'81'.repeat(32)}` };
    prior.finalized.seenEventIds = ['orphaned'];
    prior.current = structuredClone(prior.finalized);
    await writeRecord(storage, key, prior);

    const scanner = await plugin.createScanner();
    try {
      await scanner.scan();
    } finally {
      await scanner.close();
    }

    const recovered = await readRecord<ScannerCheckpoint>(storage, key);
    expect(recovered?.finalized.cursor).toEqual({
      number: '8',
      hash: `0x${'82'.repeat(32)}`,
    });
    expect(recovered?.finalized.seenEventIds).toEqual([]);
  }, 30_000);

  it('rejects unknown storage schema versions', async () => {
    const storage = new TestStorage();
    storage.values.set('ok', JSON.stringify({
      schema_version: 1,
      pqsa_revision: 'leftover',
      value: { retained: true },
    }));
    await expect(readRecord(storage, 'ok')).resolves.toEqual({ retained: true });
    storage.values.set('unknown-schema', JSON.stringify({
      schema_version: 2,
      value: {},
    }));
    await expect(readRecord(storage, 'unknown-schema')).rejects.toMatchObject({
      code: 'MigrationRequired',
    });
  });

  it('rejects missing and partial operational backups in resume/create modes', async () => {
    await expect(createTestPlugin(
      host(new TestStorage(), 1n),
      params('resume'),
    )).rejects.toMatchObject({ code: 'MissingOperationalState' });

    const storage = new TestStorage();
    await createTestPlugin(host(storage, 1n), params('create'));
    storage.values.delete('pq-stealth:v1:7:sender:hybrid-per-payment');
    await expect(createTestPlugin(
      host(storage, 1n),
      params('create'),
    )).rejects.toMatchObject({ code: 'MissingOperationalState' });
  }, 30_000);

  it('burns a fault-injected rejected seed before retrying at a durable new index', async () => {
    const storage = new TestStorage();
    const plugin = await createTestPlugin(host(storage, 1n), params('create'));
    const identity = await plugin.identity('hybrid-per-payment');
    const reserve = bindings.SenderReservation.reserve.bind(bindings.SenderReservation);
    vi.spyOn(bindings.SenderReservation, 'reserve')
      .mockImplementationOnce(() => ({
        index: '0',
        nextIndex: '1',
        complete: () => { throw new Error('SeedRejected: Kohaku fault-injected rejected seed'); },
      }) as never)
      .mockImplementation(reserve);

    await plugin.preparePayment({
      recipient: {
        metaAddress: byteHex(identity.meta_address),
        scheme: 'hybrid-per-payment',
      },
      scheme: 'hybrid-per-payment',
      payer: `0x${'10'.repeat(20)}`,
      asset: { __type: 'native' },
      amount: 1n,
    });
    const sender = JSON.parse(
      storage.values.get('pq-stealth:v1:7:sender:hybrid-per-payment')!,
    );
    expect(sender.value.nextIndex).toBe('2');
    expect(sender.value.reservations).toEqual([]);
  }, 30_000);

  it('recovers the exact reservation after a crash without reusing its counter', async () => {
    const storage = new TestStorage();
    const plugin = await createTestPlugin(host(storage, 1n), params('create'));
    const identity = await plugin.identity('mlkem-per-payment');
    const senderKey = 'pq-stealth:v1:7:sender:mlkem-per-payment';
    const sender = await readRecord<SenderEntropyRecord>(storage, senderKey);
    const reservationId = 'crashed-reservation';
    sender!.nextIndex = '1';
    sender!.reservations.push({
      id: reservationId,
      chainId: '1',
      scheme: 'mlkem-per-payment',
      index: '0',
      metaAddress: byteHex(identity.meta_address),
      payer: `0x${'10'.repeat(20)}`,
      asset: { type: 'native' },
      amount: '1',
      createdAt: Date.now(),
    });
    await writeRecord(storage, senderKey, sender!);

    const resumed = await createTestPlugin(host(storage, 1n), params('resume'));
    expect((await resumed.pendingOperations()).map(({ id }) => id)).toContain(reservationId);
    const recovered = await readRecord<SenderEntropyRecord>(storage, senderKey);
    expect(recovered?.nextIndex).toBe('1');
    expect(recovered?.reservations).toEqual([]);
  }, 30_000);

  it('burns a failed channel reservation without poisoning resume', async () => {
    const storage = new TestStorage();
    const plugin = await createTestPlugin(host(storage, 1n), params('create'));
    const identity = await plugin.identity('mlkem-channel');
    const recipient = { metaAddress: byteHex(identity.meta_address), scheme: 'mlkem-channel' as const };
    const invalid = {
      recipient,
      scheme: 'mlkem-channel' as const,
      payer: `0x${'10'.repeat(20)}` as const,
      asset: {
        __type: 'erc721' as const,
        contract: `0x${'33'.repeat(20)}` as const,
        tokenId: 1n,
      },
      amount: 2n,
    };

    await expect(plugin.preparePayment(invalid)).rejects.toThrow(/amount.*(one|1)/i);
    const senderKey = 'pq-stealth:v1:7:sender:mlkem-channel';
    const failed = await readRecord<SenderEntropyRecord>(storage, senderKey);
    expect(failed?.nextIndex).toBe('1');
    expect(failed?.reservations).toEqual([]);

    failed!.nextIndex = '2';
    failed!.reservations.push({
      id: 'poisoned-channel-reservation',
      chainId: '1',
      scheme: 'mlkem-channel',
      index: '1',
      metaAddress: recipient.metaAddress,
      payer: invalid.payer,
      asset: { type: 'erc721', contract: invalid.asset.contract, tokenId: '1' },
      amount: '2',
      createdAt: Date.now(),
    });
    await writeRecord(storage, senderKey, failed!);

    const resumed = await createTestPlugin(host(storage, 1n), params('resume'));
    const resumedSender = await readRecord<SenderEntropyRecord>(storage, senderKey);
    expect(resumedSender?.nextIndex).toBe('2');
    expect(resumedSender?.reservations).toEqual([]);
    await resumed.preparePayment({ ...invalid, amount: 1n });
    const recovered = await readRecord<SenderEntropyRecord>(storage, senderKey);
    expect(recovered?.nextIndex).toBe('3');
    expect(recovered?.reservations).toEqual([]);
  }, 30_000);

  it('recovers a persisted channel opening without replacing its operation state', async () => {
    const storage = new TestStorage();
    const plugin = await createTestPlugin(host(storage, 1n), params('create'));
    const identity = await plugin.identity('mlkem-channel');
    storage.setsUntilFailure = 3;
    await expect(plugin.preparePayment({
      recipient: { metaAddress: byteHex(identity.meta_address), scheme: 'mlkem-channel' },
      scheme: 'mlkem-channel',
      payer: `0x${'10'.repeat(20)}`,
      asset: { __type: 'native' },
      amount: 1n,
    })).rejects.toMatchObject({ code: 'StorageFailure' });

    const [opening] = await plugin.pendingOperations();
    const hash = `0x${'ab'.repeat(32)}` as const;
    await plugin.recordSubmission(opening!, 'announcement', hash);
    const key = 'pq-stealth:v1:7:chain:1:channels:mlkem-channel';
    const before = storage.values.get(key);
    expect(before).toBeDefined();

    await createTestPlugin(host(storage, 1n), params('resume'));
    expect(storage.values.get(key)).toBe(before);
    const sender = JSON.parse(storage.values.get('pq-stealth:v1:7:sender:mlkem-channel')!);
    expect(sender.value.nextIndex).toBe('1');
    expect(sender.value.reservations).toEqual([]);
  }, 30_000);

  it('rejects a raw recipient whose embedded scheme disagrees with dispatch', async () => {
    const plugin = await createTestPlugin(host(new TestStorage(), 1n), params('create'));
    const identity = await plugin.identity('mlkem-per-payment');
    await expect(plugin.resolveRecipient({
      metaAddress: byteHex(identity.meta_address),
      scheme: 'hybrid-per-payment',
    }, 'mlkem-per-payment')).rejects.toMatchObject({ code: 'MalformedMetaAddress' });
  });
});
