/**
 * Scheme 3 plugin on a local Anvil chain.
 *
 * Requires anvil and forge. From this package:
 *
 *   pnpm example
 *
 * Host is the wallet (seed, storage, RPC). createScheme3Plugin is the plugin.
 */

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
  http,
  parseEther,
  type Abi,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
import { createScheme3Plugin } from '../sdk/index.js';

type Artifact = { abi: Abi; bytecode: { object: Hex } };

const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), '../tests/fixtures/anvil');
const payer = privateKeyToAccount(
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
);
const destination = `0x${'be'.repeat(20)}` as Address;

const anvil = await startAnvil();

try {
  await main(anvil.port);
} finally {
  anvil.process.kill('SIGTERM');
}

async function main(port: number) {
  const transport = http(`http://127.0.0.1:${port}`);
  const publicClient = createPublicClient({ chain: foundry, transport });
  const walletClient = createWalletClient({ account: payer, chain: foundry, transport });

  const announcer = await deploy(walletClient, publicClient, 'ERC5564Announcer.sol', 'ERC5564Announcer');
  const registry = await deploy(walletClient, publicClient, 'ERC6538Registry.sol', 'ERC6538Registry');

  console.log('announcer', announcer);
  console.log('registry', registry);

  const host: Host = {
    keystore: new MnemonicKeystore(
      'test test test test test test test test test test test junk',
    ),
    storage: new MemoryStorage(),
    provider: kohakuViem(publicClient),
    network: { fetch: globalThis.fetch.bind(globalThis) },
  };

  const plugin = await createScheme3Plugin(host, {
    accountIndex: 0,
    mode: 'create',
    assets: [{ __type: 'native' }],
    deployment: {
      announcer,
      registry,
      announcerStartBlock: 0n,
      finalityDepth: 0n,
    },
  });

  const identity = plugin.identity();

  console.log('instance', await plugin.instanceId());
  console.log('scheme', identity.schemeId);
  console.log('meta-address bytes', (identity.metaAddress.length - 2) / 2);

  // The wallet sends registerKeys.
  await send(walletClient, publicClient, plugin.registrationTransaction());
  console.log(
    'registry lookup',
    (await plugin.resolveRecipient(payer.address)) === identity.metaAddress
      ? 'matches plugin identity'
      : 'mismatch',
  );

  const payment = await plugin.preparePayment({
    recipient: payer.address,
    asset: { __type: 'native' },
    amount: parseEther('0.2'),
  });

  console.log('stealth address', payment.announcement.stealthAddress);

  await send(walletClient, publicClient, payment.announcementTransaction);
  await send(walletClient, publicClient, payment.fundingTransaction);

  const notes = await plugin.scan();
  const [native] = await plugin.balance(undefined);

  console.log('notes', notes.length);
  console.log('balance', `${formatEther(native?.amount ?? 0n)} ETH`);

  const amount = parseEther('0.05');

  const spend = await plugin.prepareSpend({
    noteId: notes[0]!.noteId,
    recipient: destination,
    amount: amount,
  });
  console.log('spent ', `${formatEther(amount ?? 0n)} ETH`);
  // The plugin signs in WASM and broadcasts.
  const hash = await plugin.submitSpend(spend);

  await publicClient.waitForTransactionReceipt({ hash });
  console.log('spend', hash);
  console.log(
    'destination',
    `${formatEther(await publicClient.getBalance({ address: destination }))} ETH`,
  );
}

async function deploy(
  walletClient: ReturnType<typeof createWalletClient>,
  publicClient: ReturnType<typeof createPublicClient>,
  file: string,
  name: string,
): Promise<Address> {
  const artifact = JSON.parse(
    await readFile(join(fixtureRoot, `out/${file}/${name}.json`), 'utf8'),
  ) as Artifact;
  const hash = await walletClient.deployContract({
    account: payer,
    chain: foundry,
    abi: artifact.abi,
    bytecode: artifact.bytecode.object,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });

  if (!receipt.contractAddress) throw new Error(`${name} deployment has no address`);

  return receipt.contractAddress;
}

async function send(
  walletClient: ReturnType<typeof createWalletClient>,
  publicClient: ReturnType<typeof createPublicClient>,
  transaction: { to: string; data: string; value: bigint },
) {
  const hash = await walletClient.sendTransaction({
    account: payer,
    chain: foundry,
    to: transaction.to as Address,
    data: transaction.data as Hex,
    value: transaction.value,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });

  if (receipt.status !== 'success') throw new Error(`Transaction reverted: ${hash}`);

  return hash;
}

async function startAnvil(): Promise<{ process: ChildProcess; port: number }> {
  const port = await freePort();
  const process = spawn('anvil', ['--port', port.toString(), '--silent'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const transport = http(`http://127.0.0.1:${port}`);
  const publicClient = createPublicClient({ chain: foundry, transport });

  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (process.exitCode !== null) throw new Error(`Anvil exited with ${process.exitCode}`);

    try {
      await publicClient.getBlockNumber();

      return { process, port };
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  process.kill('SIGTERM');
  throw new Error('Anvil did not start');
}

function freePort(): Promise<number> {
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
