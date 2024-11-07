import {
  isEthereumAddress,
  encodeAddress as substrateEncode,
  decodeAddress as substrateDecode,
  addressToEvm,
  encodeMultiAddress,
  ethereumEncode,
} from '@polkadot/util-crypto';
import { BN } from '@polkadot/util';

/**
 * Attempts to decode an address from either EVM or Substrate format
 * @param address The address to decode
 * @returns Uint8Array of the decoded address
 */
export function decodeAddress(address: string): Uint8Array {
  if (isEthereumAddress(address)) {
    return addressToEvm(address, false);
  }
  return substrateDecode(address);
}

/**
 * Attempts to encode a public key to either EVM or Substrate format
 * @param publicKey The public key to encode (Uint8Array or hex string)
 * @param ss58Format Optional SS58 format for Substrate addresses
 * @returns Encoded address string
 */
export function encodeAddress(
  publicKey: Uint8Array | string,
  ss58Format?: number
): string {
  if (publicKey.length === 42 || publicKey.length === 20) {
    return ethereumEncode(publicKey);
  }
  return substrateEncode(publicKey, ss58Format);
}

export function createKeyMultiAddress(who: (string | Uint8Array)[], threshold: bigint | BN | number): string {
  const multisigKey = encodeMultiAddress(who, threshold);

  if (who[0] && typeof who[0] === "string" && who[0].length === 42) {
    return encodeAddress(addressToEvm(multisigKey, false));
  }

  return encodeAddress(multisigKey);
}
