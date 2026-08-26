import type { CreatePluginFn, Host, Storage } from '@kohaku-eth/plugins';
import type { Address, Hex, TxRequest } from '@kohaku-eth/provider';
import { viem as viemProvider } from '@kohaku-eth/provider/viem';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  parseEther,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createPQStealthPlugin,
  type PQStealthInstance,
  type PQStealthPluginParams,
} from '../sdk/lib.js';
import { SCHEMES, type OperationPart, type PreparedOperation } from '../sdk/types.js';

const pqStealthFactory: CreatePluginFn<PQStealthInstance, PQStealthPluginParams>
  = createPQStealthPlugin;

const account = privateKeyToAccount(
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
);
const receiver = '0x000000000000000000000000000000000000bEEF' as Address;

class TestStorage implements Storage {
  readonly _brand = 'Storage' as const;
  readonly values = new Map<string, string>();
  async set(key: string, value: string) { this.values.set(key, value); }
  async get(key: string) { return this.values.get(key) ?? null; }
}

type Artifact = { abi: readonly unknown[]; bytecode: { object: Hex } };
type Deployment = { address: Address; abi: readonly unknown[] };

let anvil: ChildProcess;
let publicClient: PublicClient;
let walletClient: WalletClient;
let announcer: Deployment;
let registry: Deployment;
let erc20: Deployment;
let erc721: Deployment;

describe('PQ stealth Phase 1 Anvil matrix', () => {
  beforeAll(async () => {
    const port = await freePort();
    anvil = spawn('anvil', ['--port', port.toString(), '--silent'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const url = `http://127.0.0.1:${port}`;
    publicClient = createPublicClient({ chain: foundry, transport: http(url) });
    walletClient = createWalletClient({ account, chain: foundry, transport: http(url) });
    await waitForAnvil(publicClient, anvil);
    announcer = await deploy('MockAnnouncer');
    registry = await deploy('MockRegistry');
    erc20 = await deploy('MockERC20');
    erc721 = await deploy('MockERC721');
  });

  afterAll(() => {
    anvil?.kill('SIGTERM');
  });

  it('registers, pays, scans and privately spends every current asset for schemes 2-5', async () => {
    const storage = new TestStorage();
    const host = createHost(storage);
    let plugin = await createPlugin(host, 'create');
    const stableInstanceId = await plugin.instanceId();
    expect(stableInstanceId).toMatch(/^pqsa:0x[0-9a-f]{64}$/);

    for (const registration of await plugin.register()) {
      await broadcastAndRecord(plugin, registration, 'registration');
    }
    expect((await plugin.refreshOperations())
      .filter(({ kind }) => kind === 'registration')
      .every(({ stage }) => stage === 'Complete')).toBe(true);

    let tokenId = 1n;
    for (const scheme of SCHEMES) {
      const assets = [
        { asset: { __type: 'native' } as const, amount: parseEther('0.2') },
        { asset: { __type: 'erc20', contract: erc20.address } as const, amount: 1_000n },
        {
          asset: { __type: 'erc721', contract: erc721.address, tokenId } as const,
          amount: 1n,
        },
      ];
      await walletClient.writeContract({
        account,
        chain: foundry,
        address: erc20.address,
        abi: erc20.abi,
        functionName: 'mint',
        args: [account.address, 1_000n],
      } as never);
      await walletClient.writeContract({
        account,
        chain: foundry,
        address: erc721.address,
        abi: erc721.abi,
        functionName: 'mint',
        args: [account.address, tokenId],
      } as never);

      for (let index = 0; index < assets.length; index += 1) {
        const { asset, amount } = assets[index]!;
        const operation = await plugin.preparePayment({
          recipient: { registrant: account.address },
          scheme,
          payer: account.address,
          asset,
          amount,
        });
        await broadcastAndRecord(plugin, operation, 'announcement');
        await plugin.refreshOperations();
        await broadcastAndRecord(plugin, operation, 'funding');
        expect((await plugin.refreshOperations()).find(({ id }) => id === operation.id)?.stage)
          .toBe('Complete');

        const announced = getAddress(`0x${operation.announcement!.stealth_address
          .map((byte) => byte.toString(16).padStart(2, '0')).join('')}`);
        if (asset.__type !== 'native') {
          const gasHash = await walletClient.sendTransaction({
            account,
            chain: foundry,
            to: announced,
            value: parseEther('0.02'),
          });
          await publicClient.waitForTransactionReceipt({ hash: gasHash });
        }

        const scanner = await plugin.createScanner();
        const found = await scanner.scan();
        await scanner.close();
        const note = found.find((candidate) =>
          candidate.address.toLowerCase() === announced.toLowerCase()
          && sameAsset(candidate.asset, asset));
        if (!note) {
          throw new Error(`Scanner missed ${scheme}/${asset.__type} at ${announced}; found ${JSON.stringify(
            found.map((candidate) => ({
              address: candidate.address,
              asset: candidate.asset,
              diagnostics: candidate.diagnostics,
            })),
            (_, value) => typeof value === 'bigint' ? value.toString() : value,
          )}`);
        }
        expect(note?.announcedMatchesDerived).toBe(true);
        expect(note?.address.toLowerCase()).toBe(announced.toLowerCase());
        expect('_match' in note).toBe(false);
        const standardBalance = (await plugin.balance([asset]))
          .find((candidate) => sameAsset(candidate.asset, asset));
        expect(standardBalance?.amount).toBeGreaterThanOrEqual(amount);

        const spend = await plugin.prepareSpend({
          noteId: note!.id,
          to: receiver,
          amount: asset.__type === 'native' ? parseEther('0.05') : undefined,
        });
        const signed = await plugin.signPreparedSpend(spend);
        expect('spend' in signed).toBe(false);
        expect(JSON.stringify(
          signed,
          (_, value) => typeof value === 'bigint' ? value.toString() : value,
        )).not.toContain('shared_secret');
        expect(signed.attempts.at(-1)?.rawTransaction).toMatch(/^0x02/);
        const submitted = await plugin.submitPreparedSpend(signed);
        await publicClient.waitForTransactionReceipt({
          hash: submitted.attempts.at(-1)!.transactionHash,
        });
        await assertRecipientOwns(asset, amount);

        if (scheme.endsWith('-channel') && index === 0) {
          plugin = await createPlugin(host, 'resume');
          expect(await plugin.instanceId()).toBe(stableInstanceId);
        }
      }
      tokenId += 1n;
    }
  });

  it('drops a removed tentative announcement and replays its immutable material on the new fork', async () => {
    const storage = new TestStorage();
    const host = createHost(storage);
    const plugin = await pqStealthFactory(host, {
      accountIndex: 1,
      operationalMode: 'create',
      deployment: {
        announcerAddress: announcer.address,
        registryAddress: registry.address,
        announcerStartBlock: 0n,
        finalityDepth: 10_000n,
        scanBatchSize: 100,
      },
    });
    const [registration] = await plugin.register({ schemes: ['mlkem-per-payment'] });
    await broadcastAndRecord(plugin, registration!, 'registration');
    await plugin.refreshOperations();
    const operation = await plugin.preparePayment({
      recipient: { registrant: account.address },
      scheme: 'mlkem-per-payment',
      payer: account.address,
      asset: { __type: 'native' },
      amount: parseEther('0.1'),
    });
    const exactAnnouncement = JSON.stringify(operation.announcement);
    const announced = `0x${operation.announcement!.stealth_address
      .map((byte) => byte.toString(16).padStart(2, '0')).join('')}`.toLowerCase();
    const snapshot = await publicClient.request({ method: 'evm_snapshot' } as never) as Hex;
    await broadcastAndRecord(plugin, operation, 'announcement');
    await plugin.refreshOperations();
    await broadcastAndRecord(plugin, operation, 'funding');
    await plugin.refreshOperations();
    const scanner = await plugin.createScanner();
    const first = (await scanner.scan()).find((note) => note.address.toLowerCase() === announced);
    await scanner.close();
    expect(first?.announcedMatchesDerived).toBe(true);

    expect(await publicClient.request({
      method: 'evm_revert',
      params: [snapshot],
    } as never)).toBe(true);
    await plugin.refreshOperations();
    expect((await plugin.notes(undefined, true))
      .some(({ eventId }) => eventId === first!.eventId)).toBe(false);

    await publicClient.request({ method: 'evm_increaseTime', params: ['0x1'] } as never);
    await broadcastAndRecord(plugin, operation, 'announcement');
    await plugin.refreshOperations();
    await broadcastAndRecord(plugin, operation, 'funding');
    const replayedOperations = await plugin.refreshOperations();
    const replayed = (await plugin.notes(undefined, true)).find((note) =>
      note.address.toLowerCase() === first!.address.toLowerCase());
    expect(replayed?.announcedMatchesDerived).toBe(true);
    expect(JSON.stringify(replayedOperations.find(({ id }) => id === operation.id)?.announcement))
      .toBe(exactAnnouncement);
  });

  it('rewinds a finalized cursor and active channel when the first contact is reorged', async () => {
    const storage = new TestStorage();
    const host = createHost(storage);
    const plugin = await pqStealthFactory(host, {
      accountIndex: 1,
      operationalMode: 'create',
      deployment: {
        announcerAddress: announcer.address,
        registryAddress: registry.address,
        announcerStartBlock: 0n,
        finalityDepth: 1n,
        scanBatchSize: 100,
      },
    });
    const [registration] = await plugin.register({ schemes: ['hybrid-channel'] });
    await broadcastAndRecord(plugin, registration!, 'registration');
    await plugin.refreshOperations();
    const input = {
      recipient: { registrant: account.address },
      scheme: 'hybrid-channel' as const,
      payer: account.address,
      asset: { __type: 'native' as const },
      amount: parseEther('0.1'),
    };
    const opening = await plugin.preparePayment(input);
    const exactAnnouncement = JSON.stringify(opening.announcement);
    const announced = `0x${opening.announcement!.stealth_address
      .map((byte) => byte.toString(16).padStart(2, '0')).join('')}`.toLowerCase();
    const snapshot = await publicClient.request({ method: 'evm_snapshot' } as never) as Hex;
    const announcementHash = await broadcastAndRecord(plugin, opening, 'announcement');
    await plugin.refreshOperations();
    await broadcastAndRecord(plugin, opening, 'funding');
    await plugin.refreshOperations();
    const first = (await plugin.notes(undefined, true)).find((note) =>
      note.address.toLowerCase() === announced);
    expect(first?.announcedMatchesDerived).toBe(true);
    const orphanedMemo = await plugin.preparePayment(input);
    expect(orphanedMemo.isChannelOpening).toBeUndefined();

    const announcementReceipt = await publicClient.getTransactionReceipt({ hash: announcementHash });
    const checkpointKey = [...storage.values.keys()].find((key) =>
      key.endsWith(':scanner:hybrid-channel'))!;
    const checkpoint = JSON.parse(storage.values.get(checkpointKey)!);
    expect(checkpoint.value.finalized.cursor).toEqual({
      number: announcementReceipt.blockNumber.toString(),
      hash: announcementReceipt.blockHash,
    });

    expect(await publicClient.request({
      method: 'evm_revert',
      params: [snapshot],
    } as never)).toBe(true);
    await publicClient.request({ method: 'evm_increaseTime', params: ['0x1'] } as never);
    await publicClient.request({ method: 'evm_mine' } as never);
    const replacementBlock = await publicClient.getBlock({
      blockNumber: announcementReceipt.blockNumber,
    });
    expect(replacementBlock.hash).not.toBe(announcementReceipt.blockHash);

    await plugin.refreshOperations();
    await expect(plugin.preparePayment(input)).rejects.toMatchObject({
      code: 'ChannelOpeningPending',
    });
    expect((await plugin.notes(undefined, true))
      .some(({ eventId }) => eventId === first!.eventId)).toBe(false);

    await broadcastAndRecord(plugin, opening, 'announcement');
    await plugin.refreshOperations();
    await broadcastAndRecord(plugin, opening, 'funding');
    await plugin.refreshOperations();
    const replayed = (await plugin.notes(undefined, true)).find((note) =>
      note.address.toLowerCase() === announced);
    expect(replayed?.announcedMatchesDerived).toBe(true);
    const nextMemo = await plugin.preparePayment(input);
    expect(nextMemo.id).not.toBe(orphanedMemo.id);
    expect(JSON.stringify(
      (await plugin.refreshOperations()).find(({ id }) => id === opening.id)?.announcement,
    )).toBe(exactAnnouncement);
  });
});

function createHost(storage: TestStorage): Host {
  return {
    storage,
    provider: viemProvider(publicClient),
    keystore: {
      deriveAt: async (path) => {
        const accountOne = path.includes("/1'/");
        if (path.endsWith("/0'")) return `0x${(accountOne ? '03' : '01').repeat(32)}`;
        return `0x${(accountOne ? '04' : '02').repeat(32)}`;
      },
    },
    network: { fetch },
  };
}

async function createPlugin(
  host: Host,
  operationalMode: 'create' | 'resume',
): Promise<PQStealthInstance> {
  return pqStealthFactory(host, {
    accountIndex: 0,
    operationalMode,
    deployment: {
      announcerAddress: announcer.address,
      registryAddress: registry.address,
      announcerStartBlock: 0n,
      finalityDepth: 0n,
      scanBatchSize: 100,
    },
  });
}

async function broadcastAndRecord(
  plugin: PQStealthInstance,
  operation: PreparedOperation,
  part: OperationPart,
): Promise<Hex> {
  const tx = operation.transactions[part] as TxRequest;
  const hash = await walletClient.sendTransaction({
    account,
    chain: foundry,
    to: tx.to!,
    data: tx.data,
    value: tx.value ?? 0n,
  });
  await publicClient.waitForTransactionReceipt({ hash });
  await plugin.recordSubmission(operation, part, hash);
  return hash;
}

function sameAsset(left: { __type: string; contract?: Address; tokenId?: bigint }, right: {
  __type: string;
  contract?: Address;
  tokenId?: bigint;
}): boolean {
  return left.__type === right.__type
    && left.contract?.toLowerCase() === right.contract?.toLowerCase()
    && left.tokenId === right.tokenId;
}

async function assertRecipientOwns(
  asset: { __type: string; contract?: Address; tokenId?: bigint },
  fundedAmount: bigint,
): Promise<void> {
  if (asset.__type === 'native') {
    expect(await publicClient.getBalance({ address: receiver })).toBeGreaterThanOrEqual(
      parseEther('0.05'),
    );
  } else if (asset.__type === 'erc20') {
    expect(await publicClient.readContract({
      address: erc20.address,
      abi: erc20.abi,
      functionName: 'balanceOf',
      args: [receiver],
    } as never) as bigint).toBeGreaterThanOrEqual(fundedAmount);
  } else {
    expect((await publicClient.readContract({
      address: erc721.address,
      abi: erc721.abi,
      functionName: 'ownerOf',
      args: [asset.tokenId],
    } as never) as string).toLowerCase()).toBe(receiver.toLowerCase());
  }
}

async function deploy(name: string): Promise<Deployment> {
  const root = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/anvil');
  const artifact = JSON.parse(await readFile(
    join(root, 'out/PQStealthMocks.sol', `${name}.json`),
    'utf8',
  )) as Artifact;
  const hash = await walletClient.deployContract({
    account,
    chain: foundry,
    abi: artifact.abi,
    bytecode: artifact.bytecode.object,
  } as never);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (!receipt.contractAddress) throw new Error(`${name} deployment returned no address`);
  return { address: receipt.contractAddress, abi: artifact.abi };
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not reserve an Anvil port');
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function waitForAnvil(client: PublicClient, process: ChildProcess): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (process.exitCode != null) throw new Error(`Anvil exited with ${process.exitCode}`);
    try {
      await client.getChainId();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error(`Anvil did not start: ${String(lastError)}`);
}
