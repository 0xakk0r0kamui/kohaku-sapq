// Anvil register, pay, scan, spend for ETH and ERC-20.
import type { Host } from '@kohaku-eth/plugins';
import { MemoryStorage, MnemonicKeystore } from '@kohaku-eth/plugins';
import { viem as kohakuViem } from '@kohaku-eth/provider/viem';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient,
  createWalletClient,
  formatEther,
  getAddress,
  http,
  numberToHex,
  parseEther,
  type Abi,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ANNOUNCEMENT_TOPIC, ERC20_ABI } from '../sdk/abi.js';
import { createScheme3Plugin } from '../sdk/index.js';
import type { Asset } from '../sdk/types.js';

type Artifact = { abi: Abi; bytecode: { object: Hex } };

const account = privateKeyToAccount(
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
);
const recipient = `0x${'be'.repeat(20)}` as Address;
const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/anvil');

let anvil: ChildProcess;
let publicClient: ReturnType<typeof createPublicClient>;
let walletClient: ReturnType<typeof createWalletClient>;
let announcer: Address;
let registry: Address;
let token: Address;

const MOCK_ERC20_ABI = [...ERC20_ABI, {
  type: 'function',
  name: 'mint',
  stateMutability: 'nonpayable',
  inputs: [
    { name: 'recipient', type: 'address' },
    { name: 'amount', type: 'uint256' },
  ],
  outputs: [],
}] as const;

describe('scheme 3 on Anvil', () => {
  beforeAll(async () => {
    const port = await freePort();

    anvil = spawn('anvil', ['--port', port.toString(), '--silent'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const transport = http(`http://127.0.0.1:${port}`);

    publicClient = createPublicClient({ chain: foundry, transport });
    walletClient = createWalletClient({ account, chain: foundry, transport });
    await waitForAnvil();
    announcer = await deploy('ERC5564Announcer.sol', 'ERC5564Announcer');
    registry = await deploy('ERC6538Registry.sol', 'ERC6538Registry');
    token = await deploy('TestERC20.sol', 'TestERC20');
    console.log('announcer', announcer);
    console.log('registry', registry);
    console.log('token', token);
  });

  afterAll(() => anvil?.kill('SIGTERM'));

  it('registers, announces, funds, scans and spends native ETH and ERC-20', async () => {
    const assets: Asset[] = [
      { __type: 'native' },
      { __type: 'erc20', contract: token },
    ];
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
      assets,
      deployment: {
        announcer,
        registry,
        announcerStartBlock: 0n,
        finalityDepth: 0n,
        scanBatchSize: 100n,
        rescanBlocks: 10n,
      },
    });

    await send(plugin.registrationTransaction());
    const identity = plugin.identity();
    const registered = await plugin.resolveRecipient(account.address);

    console.log('instance', await plugin.instanceId());
    console.log('meta-address bytes', (identity.metaAddress.length - 2) / 2);
    console.log(
      'registry lookup',
      registered === identity.metaAddress ? 'matches plugin identity' : 'mismatch',
    );

    expect(registered).toBe(identity.metaAddress);
    expect(identity.metaAddress).toHaveLength(2 + 1_250 * 2);

    const mintHash = await walletClient.writeContract({
      account,
      chain: foundry,
      address: token,
      abi: MOCK_ERC20_ABI,
      functionName: 'mint',
      args: [account.address, 1_000n],
    });

    await publicClient.waitForTransactionReceipt({ hash: mintHash });

    const nativePayment = await plugin.preparePayment({
      recipient: account.address,
      asset: assets[0]!,
      amount: parseEther('0.2'),
    });

    expect(nativePayment.announcementTransaction.to).toBe(getAddress(announcer));
    const announcementHash = await send(nativePayment.announcementTransaction);

    expect((await publicClient.getTransactionReceipt({ hash: announcementHash })).logs)
      .toHaveLength(1);
    expect(await provider.getLogs({
      address: announcer,
      fromBlock: 0n,
      toBlock: await provider.getBlockNumber(),
      topics: [ANNOUNCEMENT_TOPIC, numberToHex(4n, { size: 32 })],
    })).toHaveLength(0);
    await send(nativePayment.fundingTransaction);
    const scanned = await plugin.scan();
    const nativeNote = scanned.find((note) =>
      note.address.toLowerCase() === nativePayment.announcement.stealthAddress.toLowerCase()
      && note.asset.__type === 'native');

    expect(nativeNote?.amount, JSON.stringify(scanned, (_, value) =>
      typeof value === 'bigint' ? value.toString() : value)).toBe(parseEther('0.2'));

    console.log('native stealth address', nativePayment.announcement.stealthAddress);
    console.log('native note', `${formatEther(nativeNote!.amount)} ETH`);

    const recipientBefore = await publicClient.getBalance({ address: recipient });
    const nativeSpend = await plugin.prepareSpend({
      noteId: nativeNote!.noteId,
      recipient,
      amount: parseEther('0.05'),
    });

    expect(nativeSpend.signer).toBe(nativePayment.announcement.stealthAddress);
    const nativeHash = await plugin.submitSpend(nativeSpend);

    await publicClient.waitForTransactionReceipt({ hash: nativeHash });
    const nativeReceived = await publicClient.getBalance({ address: recipient });

    console.log('native spend', nativeHash);
    console.log('destination ETH', formatEther(nativeReceived));

    expect(nativeReceived).toBe(recipientBefore + parseEther('0.05'));

    const tokenPayment = await plugin.preparePayment({
      recipient: account.address,
      asset: assets[1]!,
      amount: 1_000n,
    });

    await send(tokenPayment.announcementTransaction);
    await send(tokenPayment.fundingTransaction);
    await send({
      to: tokenPayment.announcement.stealthAddress,
      data: '0x',
      value: parseEther('0.02'),
    });
    const tokenNote = (await plugin.scan()).find((note) =>
      note.address.toLowerCase() === tokenPayment.announcement.stealthAddress.toLowerCase()
      && note.asset.__type === 'erc20');

    expect(tokenNote?.amount).toBe(1_000n);

    console.log('token stealth address', tokenPayment.announcement.stealthAddress);
    console.log('token note', tokenNote!.amount.toString());

    const tokenSpend = await plugin.prepareSpend({
      noteId: tokenNote!.noteId,
      recipient,
      amount: 600n,
    });
    const tokenHash = await plugin.submitSpend(tokenSpend);

    await publicClient.waitForTransactionReceipt({ hash: tokenHash });
    const tokenReceived = await publicClient.readContract({
      address: token,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [recipient],
    });

    console.log('token spend', tokenHash);
    console.log('destination token', tokenReceived.toString());

    expect(tokenReceived).toBe(600n);
  });
});

async function deploy(file: string, name: string): Promise<Address> {
  const artifact = JSON.parse(await readFile(
    join(fixtureRoot, `out/${file}/${name}.json`),
    'utf8',
  )) as Artifact;
  const hash = await walletClient.deployContract({
    account,
    chain: foundry,
    abi: artifact.abi,
    bytecode: artifact.bytecode.object,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });

  if (!receipt.contractAddress) throw new Error(`${name} deployment has no address`);

  return receipt.contractAddress;
}

async function send(transaction: { to: string; data: string; value: bigint }) {
  const hash = await walletClient.sendTransaction({
    account,
    chain: foundry,
    to: transaction.to as Address,
    data: transaction.data as Hex,
    value: transaction.value,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });

  if (receipt.status !== 'success') throw new Error(`Transaction reverted: ${hash}`);

  return hash;
}

async function waitForAnvil(): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (anvil.exitCode !== null) throw new Error(`Anvil exited with ${anvil.exitCode}`);

    try {
      await publicClient.getBlockNumber();

      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new Error('Anvil did not start');
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
