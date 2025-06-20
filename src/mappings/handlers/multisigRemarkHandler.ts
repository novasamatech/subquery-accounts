import { SubstrateEvent } from "@subql/types";
import { MultisigRemark } from "../../types";
import { checkAndGetAccount } from "../../utils/checkAndGetAccount";
import { checkAndGetAccountMultisig } from "../../utils/checkAndGetAccountMultisig";
import { decodeAddress, createKeyMultiAddress } from "../../utils";
import { u8aToHex } from "@polkadot/util";
import { MultisigRemarkArgs } from "../types";

export async function handleMultisigRemarkEventHandler(event: SubstrateEvent): Promise<void> {
  if (!event) return;

  const extrinsic = event.extrinsic?.extrinsic;

  if (!extrinsic) return;

  const args = extrinsic.args[0]?.toHuman() as unknown as string;

  let parsedArgs: MultisigRemarkArgs;
  try {
    parsedArgs = JSON.parse(args) as unknown as MultisigRemarkArgs;
  } catch (e) {
    return;
  }

  if (!parsedArgs || !parsedArgs.signatories || !parsedArgs.threshold) return;

  const signer = extrinsic?.signer.toString();

  const allSignatories = [...parsedArgs.signatories, signer];
  const signatoriesAccountsPromises = allSignatories.map((signatory) =>
    checkAndGetAccount(u8aToHex(decodeAddress(signatory)))
  );
  const allSignatoriesAccounts = await Promise.all(signatoriesAccountsPromises);
  const multisigAddress = createKeyMultiAddress(allSignatories, parsedArgs.threshold);

  const multisigPubKey = u8aToHex(decodeAddress(multisigAddress));

  const multisigAccount = await checkAndGetAccount(
    multisigPubKey,
    true,
    parsedArgs.threshold
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