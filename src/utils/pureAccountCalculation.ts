import { u8aToHex, stringToU8a, u8aConcatStrict } from "@polkadot/util";
import { blake2AsU8a, decodeAddress } from "@polkadot/util-crypto";

/**
 * Parameters for calculating a pure account address
 */
export interface PureAccountParams {
  /** The spawner account (who creates the pure proxy) */
  who: string;
  /** The type of the proxy (e.g., 'Any', 'NonTransfer', etc.) */
  proxyType: Uint8Array;
  /** A disambiguation index for multiple calls in the same transaction */
  index: number;
  /** block height and extrinsic index when the pure account was created */
  maybeWhen: {
    blockHeight: number;
    extrinsicIndex: number;
  };
}

/**
 * Calculate the address of a pure proxy account.
 *
 * This is a TypeScript port of the Substrate runtime's pure_account function
 * which generates deterministic addresses for pure proxy accounts.
 *
 * @param params - The parameters for pure account calculation
 * @param currentBlockHeight - Current block height (used if maybeWhen is not provided)
 * @param currentExtrinsicIndex - Current extrinsic index (used if maybeWhen is not provided)
 * @returns The calculated pure proxy account address as a hex string
 */
export function calculatePureAccount(params: PureAccountParams): string {
  const { who, proxyType, index, maybeWhen } = params;

  // Decode the 'who' account to get the raw bytes
  const whoBytes = decodeAddress(who);

  // Create the entropy data following the Substrate pattern:
  // (b"modlpy/proxy____", who, height, ext_index, proxy_type, index)
  const entropy = createEntropyData(whoBytes, maybeWhen.blockHeight, maybeWhen.extrinsicIndex, proxyType, index);

  // Hash the entropy using blake2_256
  const hash = blake2AsU8a(entropy, 256);

  // The result is the account ID (32 bytes from the hash)
  const accountId = hash.slice(0, 32);

  return u8aToHex(accountId);
}

/**
 * Creates the entropy data for pure account calculation
 * This mimics the SCALE encoding of the tuple in Substrate
 */
function createEntropyData(who: Uint8Array, blockHeight: number, extrinsicIndex: number, proxyType: Uint8Array, index: number): Uint8Array {
  // Substrate's module prefix for proxy pallet
  const modulePrefix = stringToU8a("modlpy/proxy____");

  const blockHeightBytes = api.registry.createType("u32", blockHeight).toU8a();

  const extrinsicIndexBytes = api.registry.createType("u32", extrinsicIndex).toU8a();

  // Encode proxy type as compact string
  const proxyTypeBytes = proxyType;

  const indexBytes = api.registry.createType("u16", index).toU8a();

  // Concatenate all the data
  return u8aConcatStrict([modulePrefix, who, blockHeightBytes, extrinsicIndexBytes, proxyTypeBytes, indexBytes]);
}
