import { encodeAddress as substrateEncode, decodeAddress as substrateDecode, addressToEvm, encodeMultiAddress } from "@polkadot/util-crypto";
import { BN, u8aToHex } from "@polkadot/util";

const ETHEREUM_ADDRESS_REGEX = /^0x[0-9a-fA-F]{40}$/;

/**
 * Attempts to decode an address from either EVM or Substrate format
 * @param address The address to decode
 * @returns Uint8Array of the decoded address
 */
export function decodeAddress(address: string): Uint8Array {
  const normalizedAddress = address.trim();

  // Avoid checksum hashing path in util-crypto (isEthereumAddress -> isChecksum),
  // which can throw in SubQuery runtime bundle.
  if (ETHEREUM_ADDRESS_REGEX.test(normalizedAddress)) {
    return addressToEvm(normalizedAddress, false);
  }

  return substrateDecode(normalizedAddress, true);
}

/**
 * Attempts to encode a public key to either EVM or Substrate format
 * @param publicKey The public key to encode (Uint8Array or hex string)
 * @param ss58Format Optional SS58 format for Substrate addresses
 * @returns Encoded address string
 */
export function encodeAddress(publicKey: Uint8Array | string, ss58Format?: number): string {
  if (typeof publicKey === "string") {
    const normalizedAddress = publicKey.trim();

    if (ETHEREUM_ADDRESS_REGEX.test(normalizedAddress)) {
      return `0x${normalizedAddress.slice(2).toLowerCase()}`;
    }

    return substrateEncode(normalizedAddress, ss58Format);
  }

  if (publicKey.length === 20) {
    return u8aToHex(publicKey);
  }

  return substrateEncode(publicKey, ss58Format);
}

export function createKeyMultiAddress(who: (string | Uint8Array)[], threshold: bigint | BN | number): string {
  // Pre-decode addresses to Uint8Array to avoid checksum errors inside encodeMultiAddress
  const decoded = who.map(addr => (typeof addr === "string" ? decodeAddress(addr) : addr));
  const multisigKey = encodeMultiAddress(decoded, threshold);

  if (who[0] && typeof who[0] === "string" && ETHEREUM_ADDRESS_REGEX.test(who[0].trim())) {
    return encodeAddress(addressToEvm(multisigKey, false));
  }

  return encodeAddress(multisigKey);
}
