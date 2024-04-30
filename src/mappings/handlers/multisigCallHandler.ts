import {
  createKeyMulti,
  decodeAddress,
  encodeAddress,
} from "@polkadot/util-crypto";
import { MultisigArgs } from "../types";
import { SubstrateExtrinsic } from "@subql/types";
import { checkAndGetAccount } from "../../utils/checkAndGetAccount";
import { checkAndGetAccountMultisig } from "../../utils/checkAndGetAccountMultisig";
import { u8aToHex } from "@polkadot/util";

export async function handleMultisigCall(
  extrinsic: SubstrateExtrinsic
): Promise<void> {
  const {
    args: { threshold, other_signatories },
  } = extrinsic.extrinsic.method.toHuman() as unknown as MultisigArgs;

  const signer = extrinsic.extrinsic.signer.toString();
  const allSignatories = [...other_signatories, signer];
  const signatoriesAccountsPromises = allSignatories.map((signatory) =>
    checkAndGetAccount(u8aToHex(decodeAddress(signatory)))
  );
  const allSignatoriesAccounts = await Promise.all(signatoriesAccountsPromises);
  const mulisigPubKey = createKeyMulti(other_signatories, threshold);
  const multisigAddress = encodeAddress(mulisigPubKey);
  const multisigAccount = await checkAndGetAccount(
    u8aToHex(decodeAddress(multisigAddress)),
    true,
    threshold
  );
  const accountMultisigsPromise = allSignatoriesAccounts.map((member) =>
    checkAndGetAccountMultisig(multisigAccount.id, member.id)
  );
  const accountMultisig = await Promise.all(accountMultisigsPromise);

  await Promise.all(allSignatoriesAccounts.map((member) => member.save()));
  await multisigAccount.save();
  await Promise.all(
    accountMultisig.map((accountMultisig) => accountMultisig.save())
  );
}
