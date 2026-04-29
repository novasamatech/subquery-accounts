import { u8aToHex, u8aConcat, hexToU8a } from "@polkadot/util";
import { blake2AsU8a, decodeAddress } from "@polkadot/util-crypto";

// "modlpy/proxy____" — substrate proxy pallet pure-account derivation prefix.
// Built via hexToU8a (not stringToU8a) for the same reason as MULTISIG_PREFIX
// in addressesDecode.ts: stringToU8a relies on a host-realm TextEncoder whose
// output later breaks isU8a checks inside the SubQuery sandbox.
const PROXY_PREFIX = hexToU8a("0x6d6f646c70792f70726f78795f5f5f5f");

/**
 * Parameters for calculating a pure account address
 */
export interface PureAccountParams {
  /** The spawner account (who creates the pure proxy) */
  spawner: string;
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
  const { spawner: who, proxyType, index, maybeWhen } = params;

  // Decode the 'who' account to get the raw bytes
  const whoBytes = decodeAddress(who);

  // Create the entropy data following the Substrate pattern:
  // (b"modlpy/proxy____", who, height, ext_index, proxy_type, index)
  const entropy = createEntropyData(whoBytes, maybeWhen.blockHeight, maybeWhen.extrinsicIndex, proxyType, index);

  // Hash the entropy using blake2_256
  const hash = blake2AsU8a(entropy, 256);

  // The result is the account ID (32 or 20 bytes from the hash, depends on the spawner length)
  const accountId = hash.slice(0, whoBytes.length);

  return u8aToHex(accountId);
}

/**
 * Creates the entropy data for pure account calculation
 * This mimics the SCALE encoding of the tuple in Substrate
 */
function createEntropyData(who: Uint8Array, blockHeight: number, extrinsicIndex: number, proxyType: Uint8Array, index: number): Uint8Array {
  // Anything that originates from `api.*` (registry.createType(...).toU8a(),
  // event.data[i].toU8a(), …) lives in the host Node realm. Inside the SubQuery
  // sandbox the realm boundary breaks polkadot/util's isU8a check, so u8aConcat
  // would otherwise fall back to stringToU8a(value.toString()) and corrupt the
  // bytes. Re-wrap each one through Uint8Array.from to bring them into the
  // sandbox realm before feeding them into the polkadot pipeline.
  return u8aConcat(
    PROXY_PREFIX,
    who,
    Uint8Array.from(api.registry.createType("u32", blockHeight).toU8a()),
    Uint8Array.from(api.registry.createType("u32", extrinsicIndex).toU8a()),
    Uint8Array.from(proxyType),
    Uint8Array.from(api.registry.createType("u16", index).toU8a()),
  );
}

/**
 * Parameters for finding the correct pure block number
 */
export interface FindPureBlockNumberParams {
  /** The spawner account (who creates the pure proxy) */
  spawner: string;
  /** The expected pure account address */
  pure: string;
  /** The type of the proxy as Uint8Array */
  type: Uint8Array;
  /** A disambiguation index for multiple calls in the same transaction */
  disambiguationIndex: number;
  /** The original block number from the event */
  blockNumber: number;
  /** The extrinsic index from the event */
  extrinsicIndex: number;
}

/**
 * Finds the correct block number for pure proxy creation by checking both
 * the original block number and the relay parent number if needed.
 *
 * @param params - The parameters for finding the pure block number
 * @returns The correct block number to use for the pure proxy
 * @throws Error if neither block number nor relay parent number produces the expected pure account
 */
export async function findPureBlockNumber(params: FindPureBlockNumberParams): Promise<number> {
  const { spawner, pure, type, disambiguationIndex, blockNumber, extrinsicIndex } = params;

  // First try with the original block number
  const pureAccount = calculatePureAccount({
    spawner,
    proxyType: type,
    index: disambiguationIndex,
    maybeWhen: { blockHeight: blockNumber, extrinsicIndex },
  });

  // If the calculated pure account matches the expected one, use the original block number
  if (pure === pureAccount) {
    return blockNumber;
  }

  // If not, try with the relay parent number
  const validationData = await api.query?.["parachainSystem"]?.["validationData"]?.();

  if (!validationData) {
    throw new Error(`Validation data on chain ${chainId} not found, time to die`);
  }

  const json = validationData?.toJSON() as { relayParentNumber: number };
  const relayParentNumber = json?.relayParentNumber;

  if (relayParentNumber === undefined || relayParentNumber === null) {
    throw new Error(`Relay parent number on chain ${chainId} not found, time to die`);
  }

  const pureAccountRelayParent = calculatePureAccount({
    spawner,
    proxyType: type,
    index: disambiguationIndex,
    maybeWhen: { blockHeight: relayParentNumber, extrinsicIndex },
  });

  // If the relay parent calculation matches, use the relay parent number
  if (pure === pureAccountRelayParent) {
    return relayParentNumber;
  }

  // If neither works, throw an error
  throw new Error(`Who ${spawner} is not the pure account ${pureAccount} or the pure account relay parent ${pureAccountRelayParent}`);
}
