import type { Host } from '@kohaku-eth/plugins';
import { isAddress, type Address, type Hex } from 'viem';
import {
  decodeRegistryLookup,
  encodeRegistration,
  encodeRegistryLookup,
} from './abi.js';
import { validateMetaAddress } from './config.js';
import type { Recipient } from './types.js';

export function registrationTransaction(registry: Address, metaAddress: Hex) {
  return {
    to: registry,
    data: encodeRegistration(metaAddress),
    value: 0n,
  };
}

/** Return a meta-address, looking it up on the registry when given an account. */
export async function resolveRecipient(
  host: Host,
  registry: Address,
  recipient: Recipient,
): Promise<Hex> {
  if (typeof recipient !== 'string' && 'metaAddress' in recipient) {
    validateMetaAddress(recipient.metaAddress);

    return recipient.metaAddress;
  }

  const registrant = typeof recipient === 'string' ? recipient : recipient.registrant;

  if (!isAddress(registrant)) throw new Error('Registrant address is invalid');

  const result = await host.provider.call({
    to: registry,
    input: encodeRegistryLookup(registrant),
  });

  if (!result) throw new Error(`Registry returned no scheme 3 keys for ${registrant}`);

  const metaAddress = decodeRegistryLookup(result);

  validateMetaAddress(metaAddress);

  return metaAddress;
}
