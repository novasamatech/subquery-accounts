import { isHex, isU8a, u8aToU8a } from "@polkadot/util";
import { base58Decode, checkAddressChecksum } from "@polkadot/util-crypto";

export const PUBLIC_KEY_LENGTH_BYTES = 32;
export const ADDRESS_ALLOWED_ENCODED_LENGTHS = [35, 36, 37, 38];

export const validateSubstrateAddress = (address: string): boolean => {
  if (isU8a(address) || isHex(address)) {
    return u8aToU8a(address).length === PUBLIC_KEY_LENGTH_BYTES;
  }

  try {
    const decoded = base58Decode(address);
    if (!ADDRESS_ALLOWED_ENCODED_LENGTHS.includes(decoded.length)) return false;

    const [isValid, endPos, ss58Length] = checkAddressChecksum(decoded);

    return isValid && Boolean(decoded.slice(ss58Length, endPos));
  } catch {
    return false;
  }
};