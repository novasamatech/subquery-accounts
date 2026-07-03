import { u8aToHex } from "@polkadot/util";
import { VisitedCall } from "subquery-call-visitor";
import { MultisigArgs, MultisigThreshold1Args } from "../types";
import { checkAndGetAccount } from "../../utils/checkAndGetAccount";
import { checkAndGetAccountMultisig } from "../../utils/checkAndGetAccountMultisig";
import { decodeAddress, createKeyMultiAccountId } from "../../utils";
import { assertCryptoIntegrity } from "../../utils/cryptoIntegrity";

export const handleMultisigCall = async (call: VisitedCall): Promise<void> => {
  assertCryptoIntegrity();

  const [threshold, otherSignatories] = extractThresholdAndOtherSignatories(call);
  const allSignatories = [...otherSignatories, call.origin];

  const signatoryAccounts = await Promise.all(allSignatories.map(addr => checkAndGetAccount(toAccountId(addr))));
  const multisigAccount = await checkAndGetAccount(createKeyMultiAccountId(allSignatories, threshold), true, threshold);
  const accountMultisigs = await Promise.all(signatoryAccounts.map(member => checkAndGetAccountMultisig(multisigAccount.id, member.id)));

  await Promise.all(signatoryAccounts.map(member => member.save()));
  await multisigAccount.save();
  await Promise.all(accountMultisigs.map(link => link.save()));
};

function toAccountId(address: string): string {
  return u8aToHex(decodeAddress(address));
}

// toHuman() renders u16 as a locale-formatted string ("4", or "1,024" past 999),
// which BN would reject and the store would persist as a string.
function normalizeThreshold(threshold: number | string): number {
  const value = typeof threshold === "number" ? threshold : Number(String(threshold).replace(/,/g, ""));

  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`Invalid threshold: ${threshold}`);
  }

  return value;
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

  return [normalizeThreshold(threshold), other_signatories];
}
