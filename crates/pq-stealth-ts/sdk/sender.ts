import type { Host } from '@kohaku-eth/plugins';
import { getAddress, type Address, type Hex } from 'viem';
import { encodeAnnouncement } from './abi.js';
import { assetTransfer } from './assets.js';
import { validateAmount, validateAsset } from './config.js';
import {
  readRecord,
  withStorageLock,
  writeRecord,
  type SenderState,
} from './storage.js';
import type {
  Announcement,
  OperationalMode,
  PaymentInput,
  PreparedPayment,
} from './types.js';
import { createAnnouncement } from './wasm.js';

const MAX_U64 = (1n << 64n) - 1n;

/** Load or create the persisted sender counter. */
export async function initializeSender(
  host: Host,
  mode: OperationalMode,
  storageKey: string,
): Promise<void> {
  if (mode === 'receive-only') return;

  await withStorageLock(host.storage, async () => {
    const existing = await readRecord<SenderState>(host.storage, storageKey);

    if (mode === 'resume') {
      if (!existing) throw new Error('Resume requires the persisted sender counter');

      return;
    }

    if (existing) throw new Error('Sender state already exists; use resume mode');

    await writeRecord<SenderState>(host.storage, storageKey, { nextIndex: '0' });
  });
}

/** Advance the sender index, then build announce and fund transactions. */
export async function preparePayment(
  host: Host,
  announcer: Address,
  storageKey: string,
  senderMaster: Uint8Array,
  metaAddress: Hex,
  input: PaymentInput,
): Promise<PreparedPayment> {
  validateAmount(input.amount);
  validateAsset(input.asset);

  return withStorageLock(host.storage, async () => {
    for (;;) {
      const sender = await readRecord<SenderState>(host.storage, storageKey);

      if (!sender) throw new Error('Missing sender state');

      const senderIndex = parseSenderIndex(sender.nextIndex);

      sender.nextIndex = (senderIndex + 1n).toString();
      await writeRecord(host.storage, storageKey, sender);

      const payload = createAnnouncement(metaAddress, senderMaster, senderIndex);

      if (!payload) continue;

      const announcement: Announcement = {
        schemeId: 3,
        stealthAddress: getAddress(payload.stealthAddress),
        ephemeralPublicKey: payload.ephemeralPublicKey,
        metadata: payload.metadata,
      };

      return {
        announcement,
        announcementTransaction: {
          to: announcer,
          data: encodeAnnouncement(
            announcement.stealthAddress,
            announcement.ephemeralPublicKey,
            announcement.metadata,
          ),
          value: 0n,
        },
        fundingTransaction: assetTransfer(
          input.asset,
          announcement.stealthAddress,
          input.amount,
        ),
      };
    }
  });
}

function parseSenderIndex(value: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error('Persisted sender index is invalid');
  }

  const senderIndex = BigInt(value);

  if (senderIndex >= MAX_U64) throw new Error('Sender index exhausted');

  return senderIndex;
}
