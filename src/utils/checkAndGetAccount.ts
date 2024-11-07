import { encodeAddress } from "../utils";
import { Account } from "../types";

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
      address: encodeAddress(pubKey),
      isMultisig,
      threshold,
    });
  }
  return account;
}
