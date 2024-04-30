import { AccountMultisig } from "../types";
import { getAccountMultisigId } from "./getAccountMultisigId";

export async function checkAndGetAccountMultisig(
  multisigPubKey: string,
  signatoryPubKey: string
): Promise<AccountMultisig> {
  const id = getAccountMultisigId(signatoryPubKey, multisigPubKey);

  let accountMultisig = await AccountMultisig.get(id);
  if (!accountMultisig) {
    // We couldn't find the accountMultisig
    accountMultisig = AccountMultisig.create({
      id,
      multisigId: multisigPubKey,
      signatoryId: signatoryPubKey,
    });
  }
  return accountMultisig;
}
