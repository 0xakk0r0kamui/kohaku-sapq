import type { Host } from '@kohaku-eth/plugins';
import { MemoryStorage, MnemonicKeystore } from '@kohaku-eth/plugins';
import { viem as kohakuViem } from '@kohaku-eth/provider/viem';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import {
  createPublicClient,
  createWalletClient,
  formatEther,
  getAddress,
  http,
  parseEther,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ANNOUNCEMENT_TOPIC,
  decodeAnnouncement,
} from '../sdk/abi.js';
import { createScheme3Plugin } from '../sdk/index.js';
import type { Asset } from '../sdk/types.js';

const ANNOUNCER = getAddress('0x55649E01B5Df198D18D95b5cc5051630cfD45564');
const REGISTRY = getAddress('0x6538E6bf4B0eBd30A8Ea093027Ac2422ce5d6538');
const PUBLIC_SEPOLIA_RPC_URL = 'https://ethereum-sepolia-rpc.publicnode.com';
const SEPOLIA_CHAIN_ID = 11_155_111;
const NATIVE_ASSET: Asset = { __type: 'native' };
const PAYMENT_AMOUNT = parseEther('0.2');
const SPEND_AMOUNT = parseEther('0.05');
const account = privateKeyToAccount(
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
);
const recipient = getAddress(`0x${'be'.repeat(20)}`);

let anvil: ChildProcess;
let anvilError: Error | undefined;
let anvilStderr = '';
let publicClient: ReturnType<typeof createPublicClient>;
let walletClient: ReturnType<typeof createWalletClient>;
let forkBlock: bigint;

describe('scheme 3 on a Sepolia fork', () => {
  beforeAll(async () => {
    const configuredForkUrl = process.env['RPC_URL_SEPOLIA']?.trim();
    const usingPublicRpc = !configuredForkUrl;
    const forkUrl = configuredForkUrl || PUBLIC_SEPOLIA_RPC_URL;

    if (usingPublicRpc) {
      console.warn(
        `RPC_URL_SEPOLIA is not set in .env; using public RPC ${PUBLIC_SEPOLIA_RPC_URL}. `
        + 'Public RPCs may be rate-limited.',
      );
    }

    try {
      const port = await freePort();
      const forkBlockNumber = readForkBlock();
      const args = [
        '--fork-url',
        forkUrl,
        '--chain-id',
        SEPOLIA_CHAIN_ID.toString(),
        '--port',
        port.toString(),
        '--silent',
      ];

      if (forkBlockNumber !== undefined) {
        args.push('--fork-block-number', forkBlockNumber.toString());
      }

      anvil = spawn('anvil', args, { stdio: ['ignore', 'ignore', 'pipe'] });
      anvil.once('error', (error) => {
        anvilError = error;
      });
      anvil.stderr?.on('data', (data: Buffer) => {
        anvilStderr = `${anvilStderr}${data.toString()}`.slice(-4_000);
      });

      const transport = http(`http://127.0.0.1:${port}`);

      publicClient = createPublicClient({ chain: sepolia, transport });
      walletClient = createWalletClient({ account, chain: sepolia, transport });
      await waitForAnvil(forkUrl);

      expect(await publicClient.getChainId()).toBe(SEPOLIA_CHAIN_ID);
      forkBlock = await publicClient.getBlockNumber();

      const sourceClient = createPublicClient({
        chain: sepolia,
        transport: http(forkUrl),
      });
      const [
        announcerCode,
        registryCode,
        sourceAnnouncerCode,
        sourceRegistryCode,
      ] = await Promise.all([
        publicClient.getCode({ address: ANNOUNCER }),
        publicClient.getCode({ address: REGISTRY }),
        sourceClient.getCode({ address: ANNOUNCER, blockNumber: forkBlock }),
        sourceClient.getCode({ address: REGISTRY, blockNumber: forkBlock }),
      ]);

      expect(announcerCode).toBeDefined();
      expect(announcerCode).not.toBe('0x');
      expect(announcerCode).toBe(sourceAnnouncerCode);
      expect(registryCode).toBeDefined();
      expect(registryCode).not.toBe('0x');
      expect(registryCode).toBe(sourceRegistryCode);

      console.log('Verified Sepolia contracts', {
        forkBlock: forkBlock.toString(),
        announcer: ANNOUNCER,
        registry: REGISTRY,
      });
    } catch (error) {
      const details = redact(errorMessage(error), forkUrl);

      if (!usingPublicRpc) {
        throw new Error(`Sepolia fork setup failed: ${details}`, { cause: error });
      }

      throw new Error(
        `RPC_URL_SEPOLIA is not set in .env; public RPC ${PUBLIC_SEPOLIA_RPC_URL} failed: `
        + details,
        { cause: error },
      );
    }
  });

  afterAll(() => anvil?.kill('SIGTERM'));

  it('registers, announces, funds, scans and spends native ETH', async () => {
    const provider = kohakuViem(publicClient);
    const host: Host = {
      storage: new MemoryStorage(),
      provider,
      network: { fetch: globalThis.fetch.bind(globalThis) },
      keystore: new MnemonicKeystore(
        'test test test test test test test test test test test junk',
      ),
    };
    const plugin = await createScheme3Plugin(host, {
      accountIndex: 0,
      mode: 'create',
      assets: [NATIVE_ASSET],
      deployment: {
        announcer: ANNOUNCER,
        registry: REGISTRY,
        announcerStartBlock: forkBlock + 1n,
        finalityDepth: 0n,
        scanBatchSize: 100n,
        rescanBlocks: 10n,
      },
    });

    const registration = plugin.registrationTransaction();

    expect(getAddress(registration.to)).toBe(REGISTRY);
    const registrationReceipt = await send(registration);
    const identity = plugin.identity();

    expect(await plugin.resolveRecipient(account.address)).toBe(identity.metaAddress);
    console.log('Registered scheme 3 meta-address', {
      transaction: registrationReceipt.transactionHash,
      registrant: account.address,
      metaAddressBytes: (identity.metaAddress.length - 2) / 2,
    });

    const payment = await plugin.preparePayment({
      recipient: account.address,
      asset: NATIVE_ASSET,
      amount: PAYMENT_AMOUNT,
    });

    expect(getAddress(payment.announcementTransaction.to)).toBe(ANNOUNCER);
    const announcementReceipt = await send(payment.announcementTransaction);
    const announcementLog = announcementReceipt.logs.find((log) =>
      log.address.toLowerCase() === ANNOUNCER.toLowerCase()
      && log.topics[0] === ANNOUNCEMENT_TOPIC);

    if (!announcementLog) throw new Error('Announcement event was not emitted');

    const event = decodeAnnouncement(announcementLog.data, [...announcementLog.topics]);

    expect(event.schemeId).toBe(3n);
    expect(event.stealthAddress).toBe(payment.announcement.stealthAddress);
    expect(event.ephemeralPublicKey).toBe(payment.announcement.ephemeralPublicKey);
    expect(event.metadata).toBe(payment.announcement.metadata);
    console.log('Published scheme 3 announcement', {
      transaction: announcementReceipt.transactionHash,
      stealthAddress: event.stealthAddress,
      ephemeralPublicKeyBytes: (event.ephemeralPublicKey.length - 2) / 2,
      metadataBytes: (event.metadata.length - 2) / 2,
    });

    const fundingReceipt = await send(payment.fundingTransaction);
    const note = (await plugin.scan()).find((candidate) =>
      candidate.asset.__type === 'native'
      && candidate.address.toLowerCase()
        === payment.announcement.stealthAddress.toLowerCase());

    if (!note) throw new Error('Scanner did not find the funded stealth address');

    expect(note.amount).toBe(PAYMENT_AMOUNT);
    console.log('Scanned funded stealth address', {
      transaction: fundingReceipt.transactionHash,
      stealthAddress: note.address,
      amount: `${formatEther(note.amount)} ETH`,
    });

    const recipientBefore = await publicClient.getBalance({ address: recipient });
    const spend = await plugin.prepareSpend({
      noteId: note.noteId,
      recipient,
      amount: SPEND_AMOUNT,
    });

    expect(spend.signer).toBe(payment.announcement.stealthAddress);
    expect(spend.transaction.chainId).toBe(BigInt(SEPOLIA_CHAIN_ID));

    const spendHash = await plugin.submitSpend(spend);
    const spendReceipt = await publicClient.waitForTransactionReceipt({ hash: spendHash });

    expect(spendReceipt.status).toBe('success');
    expect(await publicClient.getBalance({ address: recipient }))
      .toBe(recipientBefore + SPEND_AMOUNT);
    console.log('Spent from stealth address', {
      transaction: spendReceipt.transactionHash,
      signer: spend.signer,
      recipient,
      amount: `${formatEther(SPEND_AMOUNT)} ETH`,
    });

    console.log('Local fork transactions', {
      registration: registrationReceipt.transactionHash,
      announcement: announcementReceipt.transactionHash,
      funding: fundingReceipt.transactionHash,
      spend: spendReceipt.transactionHash,
    });
  });
});

async function send(transaction: { to: string; data: string; value: bigint }) {
  const hash = await walletClient.sendTransaction({
    account,
    chain: sepolia,
    to: transaction.to as Address,
    data: transaction.data as Hex,
    value: transaction.value,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });

  if (receipt.status !== 'success') throw new Error(`Transaction reverted: ${hash}`);

  return receipt;
}

function readForkBlock(): bigint | undefined {
  const value = process.env['PQ_STEALTH_SEPOLIA_FORK_BLOCK']?.trim();

  if (!value) return undefined;

  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error('PQ_STEALTH_SEPOLIA_FORK_BLOCK must be a non-negative integer');
  }

  return BigInt(value);
}

async function waitForAnvil(forkUrl: string): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (anvilError) throw new Error(`Could not start Anvil: ${anvilError.message}`);

    if (anvil.exitCode !== null) {
      const details = anvilStderr.trim();
      const message = details
        ? `Anvil exited with ${anvil.exitCode}: ${redact(details, forkUrl)}`
        : `Anvil exited with ${anvil.exitCode}`;

      throw new Error(message);
    }

    try {
      await publicClient.getBlockNumber();

      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  const details = anvilStderr.trim();

  throw new Error(details
    ? `Anvil did not start within 30 seconds: ${redact(details, forkUrl)}`
    : 'Anvil did not start within 30 seconds');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function redact(message: string, value: string): string {
  return message.split(value).join('[RPC URL]');
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();

    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();

      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Could not allocate a TCP port'));

        return;
      }

      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}
