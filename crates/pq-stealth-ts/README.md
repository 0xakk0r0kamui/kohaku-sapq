# `@kohaku-eth/pq-stealth-scheme3`

Kohaku plugin for ERC-5564 scheme 3. Pass a Kohaku `Host` (keystore, storage,
RPC) to `createScheme3Plugin`. You get a `Scheme3Instance`.

## Installation

The package is not published to npm. A GitHub Release attaches the
`pnpm pack` archive. Install that file together with the Kohaku host packages
and `viem`:

```bash
pnpm add https://github.com/0xakk0r0kamui/kohaku-sapq/releases/download/pq-stealth-scheme3-v0.1.0/kohaku-eth-pq-stealth-scheme3-0.1.0.tgz \
  @kohaku-eth/plugins @kohaku-eth/provider viem
```

The downloaded release asset can also be installed from a local path with
`pnpm add ./kohaku-eth-pq-stealth-scheme3-0.1.0.tgz`.

The public API is `createScheme3Plugin` and the input and output types for
registration, payment, scanning, and spending. WASM bindings are internal.
Scheme 3 is compiled in from
[`pq-stealth-scheme3-public@3c77f49`](https://github.com/namnc/pq-stealth-scheme3-public/commit/3c77f4901a0f6abe0208b7d52a4a7e508a604293).

```ts
import {
  MemoryStorage,
  MnemonicKeystore,
  type Host,
} from '@kohaku-eth/plugins';
import { viem } from '@kohaku-eth/provider/viem';
import { createPublicClient, http } from 'viem';
import { createScheme3Plugin } from '@kohaku-eth/pq-stealth-scheme3';

const publicClient = createPublicClient({ transport: http(rpcUrl) });
const host: Host = {
  keystore: new MnemonicKeystore(mnemonic),
  storage: new MemoryStorage(),
  provider: viem(publicClient),
  network: { fetch: globalThis.fetch.bind(globalThis) },
};

const plugin = await createScheme3Plugin(host, {
  accountIndex: 0,
  mode: 'create',
  assets: [{ __type: 'native' }],
  deployment: {
    announcer,
    registry,
    announcerStartBlock,
    // Use 0n on Anvil.
    finalityDepth: 0n,
  },
});
```

`instanceId`, `notes`, and `balance` work like other Kohaku plugins. Pass
`undefined` to `notes` and `balance` for every configured asset.

```ts
await wallet.sendTransaction(plugin.registrationTransaction());

const payment = await plugin.preparePayment({
  recipient: payerAddress, // or { metaAddress } / { registrant }
  asset: { __type: 'native' },
  amount: parseEther('0.2'),
});
await wallet.sendTransaction(payment.announcementTransaction);
await wallet.sendTransaction(payment.fundingTransaction);

const notes = await plugin.scan();
const [native] = await plugin.balance(undefined);

const spend = await plugin.prepareSpend({
  noteId: notes[0].noteId,
  recipient: destination,
  amount: parseEther('0.05'),
});
const hash = await plugin.submitSpend(spend);
```

The wallet sends register, announce, and fund. The plugin signs the spend in
WASM and broadcasts it. Spend signatures are secp256k1. Scheme 3 covers
announcement key agreement (ECDH + ML-KEM).

## Sender index

`preparePayment` writes the next index before it builds the announcement. A
failed payment may skip an index.

- `create` needs empty storage
- `resume` needs the same keystore and stored sender index
- `receive-only` scans and spends only

The mnemonic restores the identity. The sender index lives in plugin storage.
Scan state includes the shared secret used to spend, so encrypt storage in
production. `MemoryStorage` is for tests and the local example.

## Example

Requires `anvil` and `forge`. From this package:

```bash
pnpm example
```

Starts a local chain, deploys the announcer and registry, and runs one native
payment. The RPC sees scanned stealth addresses.

## Tests

From the repository root:

```bash
cargo test --locked -p pq-stealth-scheme3 -- --nocapture
wasm-pack test --node crates/pq-stealth-ts
corepack pnpm@10.28.0 --filter @kohaku-eth/pq-stealth-scheme3 test
corepack pnpm@10.28.0 --filter @kohaku-eth/pq-stealth-scheme3 test:e2e
```

The Anvil E2E test deploys local fixtures and covers native ETH and ERC-20.
The Sepolia fork test uses the existing ERC-5564 announcer and ERC-6538
registry, and does not deploy contracts:

```bash
cp .env.sample .env
# Set RPC_URL_SEPOLIA and, optionally, PQ_STEALTH_SEPOLIA_FORK_BLOCK.
corepack pnpm@10.28.0 --filter @kohaku-eth/pq-stealth-scheme3 \
  test:e2e:sepolia-fork
```

If `.env` does not set `RPC_URL_SEPOLIA`, the test reports that it is using
`https://ethereum-sepolia-rpc.publicnode.com`. Public RPCs may be rate-limited.
Without `PQ_STEALTH_SEPOLIA_FORK_BLOCK`, Anvil forks the latest block.
Transactions produced by this test are local to the fork.

JS scripts need Node 22, or pnpm 10.28.0. `nvm use 22`, or prefix `pnpm` with
`corepack pnpm@10.28.0`.

Pinned to
[`pq-stealth-scheme3-public@3c77f49`](https://github.com/namnc/pq-stealth-scheme3-public/commit/3c77f4901a0f6abe0208b7d52a4a7e508a604293).
After changing the revision, copy vectors with
`tools/update-scheme3-fixtures.sh PATH_TO_CHECKOUT`. Sibling checkout:
`cargo test --config .cargo/pqsa-scheme3-local.toml`.

## License

The Kohaku integration is available under the MIT License. The WebAssembly
binary includes Apache-2.0 code from `pq-stealth-scheme3-public`; see
`THIRD_PARTY_NOTICES.md` and `LICENSES/Apache-2.0.txt` in the package.
