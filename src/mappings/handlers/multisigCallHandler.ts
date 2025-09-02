import { MultisigArgs, MultisigThreshold1Args } from "../types";
import { SubstrateExtrinsic } from "@subql/types";
import { checkAndGetAccount } from "../../utils/checkAndGetAccount";
import { checkAndGetAccountMultisig } from "../../utils/checkAndGetAccountMultisig";
import { u8aToHex } from "@polkadot/util";
import { decodeAddress, createKeyMultiAddress } from "../../utils";

export async function handleMultisigCall(extrinsic: SubstrateExtrinsic): Promise<void> {
  let [threshold, other_signatories] = extractThresholdAndOtherSignatories(extrinsic);

  const signer = extrinsic.extrinsic.signer.toString();
  const allSignatories = [...other_signatories, signer];
  const signatoriesAccountsPromises = allSignatories.map(signatory => checkAndGetAccount(u8aToHex(decodeAddress(signatory))));
  const allSignatoriesAccounts = await Promise.all(signatoriesAccountsPromises);
  const multisigAddress = createKeyMultiAddress(allSignatories, threshold);
  const multisigAccount = await checkAndGetAccount(u8aToHex(decodeAddress(multisigAddress)), true, threshold);
  const accountMultisigsPromise = allSignatoriesAccounts.map(member => checkAndGetAccountMultisig(multisigAccount.id, member.id));
  const accountMultisig = await Promise.all(accountMultisigsPromise);

  await Promise.all(allSignatoriesAccounts.map(member => member.save()));
  await multisigAccount.save();
  await Promise.all(accountMultisig.map(accountMultisig => accountMultisig.save()));
}

function validateThreshold(threshold: number) {
  if (threshold < 1) {
    throw new Error(`Invalid threshold: ${threshold}`);
  }
}

function extractThresholdAndOtherSignatories(extrinsic: SubstrateExtrinsic): [number, string[]] {
  if (extrinsic.extrinsic.method.method == "asMultiThreshold1") {
    const {
      args: { other_signatories },
    } = extrinsic.extrinsic.method.toHuman() as unknown as MultisigThreshold1Args;

    return [1, other_signatories];
  } else {
    const {
      args: { threshold, other_signatories },
    } = extrinsic.extrinsic.method.toHuman() as unknown as MultisigArgs;

    validateThreshold(threshold);

    return [threshold, other_signatories];
  }
}
