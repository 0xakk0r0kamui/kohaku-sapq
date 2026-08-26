# `@kohaku-eth/pq-stealth` (Phase 1, private)

Experimental Kohaku adapter for the pinned PQSA schemes 2-5. The package remains private through
integration and may be published only after all Phase 1 changes merge with the native/WASM
conformance, persistence, reorg, and Anvil matrices green.

## Kohaku plugin contract

`createPQStealthPlugin` is a standard Kohaku `CreatePluginFn` returning a
`PQStealthInstance`. The instance implements `instanceId()`, `balance(assets)` and
`notes(assets, includeSpent)`; PQ registration, payment, scanner, tracking and spend methods are
typed plugin extras. Its feature map is empty, so no shield/unshield/transfer aliases are exposed.

`instanceId()` is a chain-independent `pqsa:0x…` fingerprint of the four ordered upstream
meta-addresses. It identifies the Kohaku plugin instance but is not a payment address or spending
authority.

## Key paths and recovery

- Recipient identity: `m/5564'/60'/{accountIndex}'/0'`
- Global sender entropy: `m/5564'/60'/{accountIndex}'/1'`

PQSA keygen derivation runs after BIP-32. A mnemonic-only recovery reconstructs recipient
identities and supports cold scanning, but cannot safely resume sending: the next-unused sender
indices and every channel role record must come from an exact operational backup. Use
`operationalMode: "recipient-only"`, restore that backup with `"resume"`, or explicitly choose a
new `accountIndex` with `"create"`. Loss, abandonment, and rejected seeds burn counters; they are
never rewound, including after a reorg.

## Scanning and privacy

Scanning starts at `announcerStartBlock`, replays the non-final tail from the last finalized
snapshot, and writes channel state, notes, and both cursors as one aggregate checkpoint. Cold sync
does one ML-KEM decapsulation per candidate first-contact/per-payment log and can be expensive.

Asset discovery queries `Transfer` logs whose indexed sender or recipient is each matched stealth
address, then calls `balanceOf`/`ownerOf`. **Those address-filtered RPC requests disclose the set of
matched stealth addresses to the RPC provider.** Phase 1 accepts this trade-off. Use a trusted RPC
or a future privacy-preserving indexer if that disclosure is unacceptable.

## Transaction and reorg behavior

Managed mode signs raw EIP-1559 transactions, persists their exact bytes and hash, then calls
`eth_sendRawTransaction`. Prepare-only mode returns intents and requires the caller to report
submissions/replacements. A reorg rolls observed lifecycle state backward but never rebuilds an
announcement, rewinds sender entropy, or rewinds a sender channel. Channel memos remain disabled
until the first-contact announcement is finalized and its funding transaction is mined. Token
funding and spending receipts are accepted only when a strict `Transfer` log matches the exact
prepared sender, recipient, amount/token id, and contract.

Match material stays in host storage (which the host must protect) and one-time scalars stay in
Rust/WASM. Public notes do not contain shared secrets, and spend preparation/signing returns only
transaction state and raw signed bytes.

## Verification

PQSA is pinned by git `rev` in the workspace `Cargo.toml`. Storage compatibility is `schema_version` only. For a sibling `pq-stealth-reference-public` checkout, paste `.cargo/pqsa-local-patch.toml` into that `Cargo.toml` and do not commit it.

- `cargo test -p pq-stealth -p pq-stealth-ethereum` runs native tests and the pinned 48 cases.
- `pnpm test:wasm-conformance` executes those same checksum-verified vectors in Node/WASM.
- `pnpm test` runs wire, persistence, concurrency, lifecycle, crash, and role-guard regressions.
- `pnpm test:e2e` runs the Anvil matrix for four schemes and native/ERC-20/ERC-721 holdings,
  including channel restart, opaque spend, and tentative-tail reorg replay.

Not included: scheme 6, ERC-4337, PQ spending, shield/unshield/transfer aliases,
`externalSyncProvider`, or multi-tab/process CAS. Phase 1 supports one writer per runtime; the
module-global mutex coordinates plugin instances only when they share the same `Storage` object.
