import {
  decodeEventLog,
  decodeFunctionResult,
  encodeFunctionData,
  getAddress,
  toEventSelector,
  type Address,
  type Hex,
} from 'viem';

export const ANNOUNCEMENT_TOPIC = toEventSelector(
  'Announcement(uint256,address,address,bytes,bytes)',
);

export const ANNOUNCER_ABI = [{
  type: 'event',
  name: 'Announcement',
  inputs: [
    { name: 'schemeId', type: 'uint256', indexed: true },
    { name: 'stealthAddress', type: 'address', indexed: true },
    { name: 'caller', type: 'address', indexed: true },
    { name: 'ephemeralPubKey', type: 'bytes', indexed: false },
    { name: 'metadata', type: 'bytes', indexed: false },
  ],
}, {
  type: 'function',
  name: 'announce',
  stateMutability: 'nonpayable',
  inputs: [
    { name: 'schemeId', type: 'uint256' },
    { name: 'stealthAddress', type: 'address' },
    { name: 'ephemeralPubKey', type: 'bytes' },
    { name: 'metadata', type: 'bytes' },
  ],
  outputs: [],
}] as const;

export const REGISTRY_ABI = [{
  type: 'function',
  name: 'registerKeys',
  stateMutability: 'nonpayable',
  inputs: [
    { name: 'schemeId', type: 'uint256' },
    { name: 'stealthMetaAddress', type: 'bytes' },
  ],
  outputs: [],
}, {
  type: 'function',
  name: 'stealthMetaAddressOf',
  stateMutability: 'view',
  inputs: [
    { name: 'registrant', type: 'address' },
    { name: 'schemeId', type: 'uint256' },
  ],
  outputs: [{ name: '', type: 'bytes' }],
}] as const;

export const ERC20_ABI = [{
  type: 'function',
  name: 'transfer',
  stateMutability: 'nonpayable',
  inputs: [
    { name: 'to', type: 'address' },
    { name: 'amount', type: 'uint256' },
  ],
  outputs: [{ name: '', type: 'bool' }],
}, {
  type: 'function',
  name: 'balanceOf',
  stateMutability: 'view',
  inputs: [{ name: 'account', type: 'address' }],
  outputs: [{ name: '', type: 'uint256' }],
}] as const;

export function encodeRegistration(metaAddress: Hex): Hex {
  return encodeFunctionData({
    abi: REGISTRY_ABI,
    functionName: 'registerKeys',
    args: [3n, metaAddress],
  });
}

export function encodeRegistryLookup(registrant: Address): Hex {
  return encodeFunctionData({
    abi: REGISTRY_ABI,
    functionName: 'stealthMetaAddressOf',
    args: [registrant, 3n],
  });
}

export function decodeRegistryLookup(result: Hex): Hex {
  return decodeFunctionResult({
    abi: REGISTRY_ABI,
    functionName: 'stealthMetaAddressOf',
    data: result,
  });
}

export function encodeAnnouncement(
  stealthAddress: Address,
  ephemeralPublicKey: Hex,
  metadata: Hex,
): Hex {
  return encodeFunctionData({
    abi: ANNOUNCER_ABI,
    functionName: 'announce',
    args: [3n, stealthAddress, ephemeralPublicKey, metadata],
  });
}

export function decodeAnnouncement(data: Hex, topics: Hex[]) {
  const decoded = decodeEventLog({
    abi: ANNOUNCER_ABI,
    eventName: 'Announcement',
    data,
    topics: topics as [Hex, ...Hex[]],
    strict: true,
  });

  return {
    schemeId: decoded.args.schemeId,
    stealthAddress: getAddress(decoded.args.stealthAddress),
    ephemeralPublicKey: decoded.args.ephemeralPubKey,
    metadata: decoded.args.metadata,
  };
}

export function encodeErc20Transfer(recipient: Address, amount: bigint): Hex {
  return encodeFunctionData({
    abi: ERC20_ABI,
    functionName: 'transfer',
    args: [recipient, amount],
  });
}

export function encodeErc20Balance(owner: Address): Hex {
  return encodeFunctionData({
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [owner],
  });
}

export function decodeErc20Balance(result: Hex): bigint {
  return decodeFunctionResult({
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    data: result,
  });
}
