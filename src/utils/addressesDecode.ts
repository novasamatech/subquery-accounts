import { encodeAddress as substrateEncode, decodeAddress as substrateDecode, addressToEvm, blake2AsU8a } from "@polkadot/util-crypto";
import { BN, u8aToHex, u8aSorted, u8aConcat, bnToU8a, compactToU8a, hexToU8a } from "@polkadot/util";

const ETHEREUM_ADDRESS_REGEX = /^0x[0-9a-fA-F]{40}$/;

// "modlpy/utilisuba" — substrate multisig pallet derivation prefix.
// We can't build it with stringToU8a inside the SubQuery sandbox: stringToU8a's
// TextEncoder lives in the host Node realm, and its returned Uint8Array fails
// sandbox-side `instanceof Uint8Array` checks. Downstream u8aConcat then mis-detects
// the prefix as "not a Uint8Array" and falls back to stringToU8a(value.toString()),
// which corrupts the bytes (e.g. "109,111,…" written as ASCII). hexToU8a allocates
// a fresh Uint8Array via `new Uint8Array` in the sandbox realm, so the rest of the
// polkadot pipeline (u8aConcat / blake2AsU8a / etc.) works as advertised.
const MULTISIG_PREFIX = hexToU8a("0x6d6f646c70792f7574696c6973756261");
const THRESHOLD_LE_OPTS = { isLe: true, bitLength: 16 };

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

/**
 * Derive a Substrate multisig account address from its signatories and threshold.
 *
 * Functionally equivalent to @polkadot/util-crypto's `encodeMultiAddress`, but
 * provides our own MULTISIG_PREFIX (see above) instead of letting the library
 * compute it via stringToU8a — the only place in the chain that breaks under
 * the SubQuery sandbox.
 *
 * @param who Array of SS58/EVM addresses or pre-decoded public keys
 * @param threshold Number of approvals required to dispatch a multisig call
 * @returns The multisig account address (SS58 for Substrate, 0x… for EVM)
 */
export function createKeyMultiAddress(who: (string | Uint8Array)[], threshold: bigint | BN | number): string {
  const decoded = who.map(addr => (typeof addr === "string" ? decodeAddress(addr) : addr));
  const blakeInput = u8aConcat(MULTISIG_PREFIX, compactToU8a(decoded.length), ...u8aSorted(decoded), bnToU8a(threshold as number, THRESHOLD_LE_OPTS));
  const multisigKey = blake2AsU8a(blakeInput);

  if (typeof who[0] === "string" && ETHEREUM_ADDRESS_REGEX.test(who[0].trim())) {
    return encodeAddress(addressToEvm(multisigKey, false));
  }

  return encodeAddress(multisigKey);
}
