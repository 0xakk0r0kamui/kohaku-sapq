import type { PublicClient } from 'viem';
import { describe, expect, it, vi as mock } from 'vitest';
import { viem } from '../src/viem/index.js';

describe('provider identity prerequisites', () => {
  it('forwards raw topics through eth_getLogs and preserves canonical log identity', async () => {
    const topic = `0x${'12'.repeat(32)}` as const;
    const request = mock.fn().mockResolvedValue([{
      blockNumber: '0x2a',
      blockHash: `0x${'21'.repeat(32)}`,
      transactionHash: `0x${'31'.repeat(32)}`,
      transactionIndex: '0x3',
      logIndex: '0x4',
      removed: false,
      address: `0x${'41'.repeat(20)}`,
      topics: [topic],
      data: '0x1234',
    }]);
    const provider = viem({ request } as unknown as PublicClient);

    const [log] = await provider.getLogs({
      fromBlock: 40n,
      toBlock: 50n,
      topics: [topic],
    } as never);

    expect(request).toHaveBeenCalledWith({
      method: 'eth_getLogs',
      params: [{ fromBlock: '0x28', toBlock: '0x32', topics: [topic] }],
    });
    expect(log).toEqual({
      blockNumber: 42n,
      blockHash: `0x${'21'.repeat(32)}`,
      transactionHash: `0x${'31'.repeat(32)}`,
      transactionIndex: 3n,
      logIndex: 4n,
      removed: false,
      address: `0x${'41'.repeat(20)}`,
      topics: [topic],
      data: '0x1234',
    });
  });

  it('returns complete canonical block identity', async () => {
    const request = mock.fn().mockResolvedValue({
      number: '0x2a',
      hash: `0x${'51'.repeat(32)}`,
      parentHash: `0x${'61'.repeat(32)}`,
    });
    const provider = viem({ request } as unknown as PublicClient);

    await expect(provider.getBlockHeader(42n)).resolves.toEqual({
      number: 42n,
      hash: `0x${'51'.repeat(32)}`,
      parentHash: `0x${'61'.repeat(32)}`,
    });
    expect(request).toHaveBeenCalledWith({
      method: 'eth_getBlockByNumber',
      params: ['0x2a', false],
    });
  });

  it('reads the head directly instead of using viem action caching', async () => {
    const request = mock.fn().mockResolvedValueOnce('0x2a').mockResolvedValueOnce('0x2b');
    const provider = viem({ request } as unknown as PublicClient);

    await expect(provider.getBlockNumber()).resolves.toBe(42n);
    await expect(provider.getBlockNumber()).resolves.toBe(43n);
    expect(request).toHaveBeenNthCalledWith(1, { method: 'eth_blockNumber' });
    expect(request).toHaveBeenNthCalledWith(2, { method: 'eth_blockNumber' });
  });

  it('normalizes receipt-not-found across duplicated viem package instances', async () => {
    const error = Object.assign(new Error('not found'), {
      name: 'TransactionReceiptNotFoundError',
    });
    const provider = viem({
      request: mock.fn(),
      getTransactionReceipt: mock.fn().mockRejectedValue(error),
    } as unknown as PublicClient);

    await expect(provider.getTransactionReceipt(`0x${'12'.repeat(32)}`)).resolves.toBeNull();
  });

  it('retains complete receipt and nested log identity', async () => {
    const transactionHash = `0x${'71'.repeat(32)}` as const;
    const blockHash = `0x${'72'.repeat(32)}` as const;
    const getTransactionReceipt = mock.fn().mockResolvedValue({
      blockNumber: 42n,
      blockHash,
      transactionHash,
      transactionIndex: 3,
      from: `0x${'73'.repeat(20)}`,
      to: `0x${'74'.repeat(20)}`,
      contractAddress: null,
      status: 'success',
      logs: [{
        blockNumber: 42n,
        blockHash,
        transactionHash,
        transactionIndex: 3,
        logIndex: 4,
        removed: false,
        address: `0x${'75'.repeat(20)}`,
        topics: [`0x${'76'.repeat(32)}`],
        data: '0x1234',
      }],
      gasUsed: 21_000n,
      cumulativeGasUsed: 42_000n,
      effectiveGasPrice: 7n,
    });
    const provider = viem({
      request: mock.fn(),
      getTransactionReceipt,
    } as unknown as PublicClient);

    const receipt = await provider.getTransactionReceipt(transactionHash);

    expect(receipt).toMatchObject({
      blockNumber: 42n,
      blockHash,
      transactionHash,
      transactionIndex: 3n,
      status: 1n,
      cumulativeGasUsed: 42_000n,
      effectiveGasPrice: 7n,
    });
    expect(receipt?.logs[0]).toMatchObject({
      blockHash,
      transactionHash,
      transactionIndex: 3n,
      logIndex: 4n,
    });
  });
});
