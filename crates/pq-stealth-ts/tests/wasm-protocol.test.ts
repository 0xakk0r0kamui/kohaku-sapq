import { beforeAll, describe, expect, it } from 'vitest';
import {
  bindings,
  buildAssetTransfer,
  byteHex,
  deriveIdentity,
  ensureInitialized,
  signSpend,
} from '../sdk/wasm.js';
import { SCHEMES, type MatchMaterial, type SchemeKind } from '../sdk/types.js';
import { scannerWorkerApi } from '../src/scanner-api.js';

describe('pinned PQSA WASM boundary', () => {
  beforeAll(() => ensureInitialized());

  for (const scheme of SCHEMES) {
    it(`round-trips generate/scan for ${scheme}`, async () => {
      const keygenMaster = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
      const senderMaster = Uint8Array.from({ length: 32 }, (_, index) => 255 - index);
      const identity = await deriveIdentity(scheme, keygenMaster);
      const reservation = bindings.SenderReservation.reserve(scheme, senderMaster, '0');
      expect(reservation.index).toBe('0');
      expect(reservation.nextIndex).toBe('1');
      const prepared = reservation.complete(Uint8Array.from(identity.meta_address)) as {
        announcement: {
          ephemeral_pubkey: number[];
          metadata: number[];
        };
        sender_channel?: number[];
      };
      const expected = {
        'mlkem-per-payment': { meta: 1_217, ephemeral: 1_088, metadata: 8 },
        'hybrid-per-payment': { meta: 1_250, ephemeral: 33, metadata: 1_096 },
        'mlkem-channel': { meta: 1_217, ephemeral: 0, metadata: 1_096 },
        'hybrid-channel': { meta: 1_250, ephemeral: 33, metadata: 1_096 },
      }[scheme];
      expect(identity.meta_address).toHaveLength(expected.meta);
      expect(prepared.announcement.ephemeral_pubkey).toHaveLength(expected.ephemeral);
      expect(prepared.announcement.metadata).toHaveLength(expected.metadata);

      const result = scheme.endsWith('-channel')
        ? bindings.scan_channel(
          scheme,
          keygenMaster,
          identity.accepted_j.toString(),
          Uint8Array.from(identity.meta_address),
          prepared.announcement,
          [],
          37,
        ) as {
          matched?: { announced_matches_derived: boolean; material: MatchMaterial };
          channel_blobs: number[][];
        }
        : {
          matched: bindings.scan_payment(
            scheme,
            keygenMaster,
            identity.accepted_j.toString(),
            Uint8Array.from(identity.meta_address),
            prepared.announcement,
          ) as { announced_matches_derived: boolean; material: MatchMaterial },
          channel_blobs: [],
        };

      expect(result.matched?.announced_matches_derived).toBe(true);
      const material = result.matched!.material;
      const signed = await signSpend(keygenMaster, identity.accepted_j, material, {
        chainId: 31337n,
        nonce: 0,
        gasLimit: 21_000n,
        maxFeePerGas: 2n,
        maxPriorityFeePerGas: 1n,
        to: `0x${'55'.repeat(20)}`,
        value: 1n,
        data: '0x',
      });
      expect(signed.signer).toBe(byteHex(material.stealth_address));
      expect(signed.raw).toMatch(/^0x02/);
      expect(signed.hash).toMatch(/^0x[0-9a-f]{64}$/);
      if (scheme.endsWith('-channel')) {
        expect(prepared.sender_channel).toHaveLength(82);
        expect(prepared.sender_channel?.[0]).toBe(0x01);
        const memo = bindings.pay_channel(
          scheme,
          Uint8Array.from(prepared.sender_channel!),
        ) as { announcement: { ephemeral_pubkey: number[]; metadata: number[] } };
        expect(memo.announcement.ephemeral_pubkey).toHaveLength(0);
        expect(memo.announcement.metadata).toHaveLength(8);
        expect(result.channel_blobs).toHaveLength(1);
        expect(result.channel_blobs[0]).toHaveLength(86);
        expect(result.channel_blobs[0]?.[0]).toBe(0x02);
        expect(Array.from(result.channel_blobs[0]!).slice(-4)).toEqual([0, 0, 0, 37]);
        const watch = bindings.export_channel_watch(
          scheme,
          Uint8Array.from(result.channel_blobs[0]!),
        ) as { bytes: number[] };
        expect(watch.bytes).toHaveLength(53);
        expect(watch.bytes[0]).toBe(0x03);
        expect(() => bindings.pay_channel(scheme, Uint8Array.from(result.channel_blobs[0]!)))
          .toThrow(/role/i);
      }
    }, 30_000);
  }

  it('dispatches a scheme 3/5 payload collision by scheme id before shape', async () => {
    const keygenMaster = new Uint8Array(32).fill(4);
    const identity = await deriveIdentity('hybrid-per-payment', keygenMaster);
    const foreign = {
      scheme: 'hybrid-per-payment' as SchemeKind,
      scheme_id: 5,
      stealth_address: new Array(20).fill(0),
      ephemeral_pubkey: new Array(33).fill(0),
      metadata: new Array(1096).fill(0),
    };
    expect(bindings.scan_payment(
      'hybrid-per-payment',
      keygenMaster,
      identity.accepted_j.toString(),
      Uint8Array.from(identity.meta_address),
      foreign,
    )).toBeUndefined();
    expect(byteHex(identity.meta_address)).toMatch(/^0x/);
  });

  it('rejects tracking/meta mismatch and skips malformed public logs diagnostically', async () => {
    const ownerMaster = new Uint8Array(32).fill(7);
    const strangerMaster = new Uint8Array(32).fill(8);
    const identity = await deriveIdentity('mlkem-per-payment', ownerMaster);
    const stranger = await deriveIdentity('mlkem-per-payment', strangerMaster);
    const prepared = bindings.SenderReservation
      .reserve('mlkem-per-payment', new Uint8Array(32).fill(9), '0')
      .complete(Uint8Array.from(identity.meta_address));
    expect(() => bindings.scan_payment(
      'mlkem-per-payment',
      strangerMaster,
      stranger.accepted_j.toString(),
      Uint8Array.from(identity.meta_address),
      (prepared as { announcement: unknown }).announcement,
    )).toThrow();

    const malformed = await scannerWorkerApi.scan({
      scheme: 'mlkem-per-payment',
      identity,
      keygenMaster: Array.from(ownerMaster),
      lookahead: 20,
      initialChannelBook: [],
      finalizedThrough: '1',
      logs: [{
        blockNumber: '1',
        blockHash: `0x${'11'.repeat(32)}`,
        transactionHash: `0x${'22'.repeat(32)}`,
        transactionIndex: '0',
        logIndex: '0',
        removed: false,
        address: `0x${'33'.repeat(20)}`,
        topics: ['0x00'],
        data: '0x',
      }],
    });
    expect(malformed.matches).toEqual([]);
    expect(malformed.diagnostics).toHaveLength(1);
    expect(malformed.diagnostics[0]).toMatch(/Skipped malformed ERC-5564 log/);
  });

  it('builds all asset intents and enforces the ERC-721 amount invariant', async () => {
    const from = `0x${'11'.repeat(20)}` as const;
    const to = `0x${'22'.repeat(20)}` as const;
    const token = `0x${'33'.repeat(20)}` as const;
    const native = await buildAssetTransfer({ __type: 'native' }, from, to, 9n, false);
    const erc20 = await buildAssetTransfer(
      { __type: 'erc20', contract: token }, from, to, 9n, false,
    );
    const erc721 = await buildAssetTransfer(
      { __type: 'erc721', contract: token, tokenId: 7n }, from, to, 1n, true,
    );

    expect(native).toMatchObject({ to, value: 9n, data: '0x' });
    expect(erc20.data).toMatch(/^0xa9059cbb/);
    expect(erc721.data).toMatch(/^0x42842e0e/);
    await expect(buildAssetTransfer(
      { __type: 'erc721', contract: token, tokenId: 7n }, from, to, 2n, true,
    )).rejects.toThrow(/amount.*(one|1)/i);
  });
});
