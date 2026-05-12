import { u8aToHex } from "@polkadot/util";
import { VisitedCall } from "subquery-call-visitor";
import { MultisigArgs, MultisigThreshold1Args } from "../types";
import { checkAndGetAccount } from "../../utils/checkAndGetAccount";
import { checkAndGetAccountMultisig } from "../../utils/checkAndGetAccountMultisig";
import { decodeAddress, createKeyMultiAddress } from "../../utils";

export const handleMultisigCall = async (call: VisitedCall): Promise<void> => {
  const [threshold, otherSignatories] = extractThresholdAndOtherSignatories(call);
  const allSignatories = [...otherSignatories, call.origin];

  const signatoryAccounts = await Promise.all(allSignatories.map(addr => checkAndGetAccount(toAccountId(addr))));
  const multisigAccount = await checkAndGetAccount(toAccountId(createKeyMultiAddress(allSignatories, threshold)), true, threshold);
  const accountMultisigs = await Promise.all(signatoryAccounts.map(member => checkAndGetAccountMultisig(multisigAccount.id, member.id)));

  await Promise.all(signatoryAccounts.map(member => member.save()));
  await multisigAccount.save();
  await Promise.all(accountMultisigs.map(link => link.save()));
};

function toAccountId(address: string): string {
  return u8aToHex(decodeAddress(address));
}

function validateThreshold(threshold: number): void {
  if (threshold < 1) {
    throw new Error(`Invalid threshold: ${threshold}`);
  }
}

function extractThresholdAndOtherSignatories(call: VisitedCall): [number, string[]] {
  if (call.call.method === "asMultiThreshold1") {
    const {
      args: { other_signatories },
    } = call.call.toHuman() as unknown as MultisigThreshold1Args;
    return [1, other_signatories];
  }

  const {
    args: { threshold, other_signatories },
  } = call.call.toHuman() as unknown as MultisigArgs;

  validateThreshold(threshold);

  return [threshold, other_signatories];
}
