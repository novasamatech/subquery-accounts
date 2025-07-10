import { decodeAddress, encodeAddress } from "../utils";
import { Account } from "../types";
import { u8aToHex } from "@polkadot/util";

export async function checkAndGetAccount(
  pubKey: string,
  isMultisig = false,
  threshold = 0
): Promise<Account> {
  let account = await Account.get(pubKey);
  if (!account) {
    // We couldn't find the account
    account = Account.create({
      id: pubKey,
      accountId: pubKey,
      isMultisig,
      threshold,
    });
  }
  return account;
}
