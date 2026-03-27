import { isHex, isU8a, u8aToU8a } from "@polkadot/util";
import { base58Decode, checkAddressChecksum } from "@polkadot/util-crypto";

export const PUBLIC_KEY_LENGTH_BYTES = 32;
export const ADDRESS_ALLOWED_ENCODED_LENGTHS = [35, 36, 37, 38];
export const ETHEREUM_PUBLIC_KEY_LENGTH_BYTES = 20;
const ETHEREUM_ADDRESS_REGEX = /^0x[0-9a-fA-F]{40}$/;

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

export const validateEvmAddress = (address: string): boolean => {
  if (!isU8a(address) && !isHex(address)) return false;

  return u8aToU8a(address).length === ETHEREUM_PUBLIC_KEY_LENGTH_BYTES;
};

export const validateAddress = (address: string): boolean => {
  const normalizedAddress = address.trim();

  if (ETHEREUM_ADDRESS_REGEX.test(normalizedAddress)) {
    return validateEvmAddress(normalizedAddress);
  }

  return validateSubstrateAddress(normalizedAddress);
};
