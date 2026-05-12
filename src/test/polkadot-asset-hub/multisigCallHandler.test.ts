import { subqlTest } from "@subql/testing";
import { Account, AccountMultisig } from "../../types";

// Polkadot Asset Hub block 1317999, extrinsic 2 — the very first multisig on this chain.
//   call:   multisig.approveAsMulti(threshold = 2, other_signatories = [S2, S3], call_hash = 0x83f8c2cd…)
//   signer: 14r9U…  (S1, pubkey 0xaa30…)
// Runtime emits NewMultisig with multisig = 14Wk5w2vC1R4LFuSZKo5Nmesm1qXUa9NpphzS64LEqxCmjRT,
// which is the 2-of-3 derivation of {S1, S2, S3}. handleNestedCalls must reproduce the same
// derivation when it walks the multisig.approveAsMulti call.
//
// https://assethub-polkadot.subscan.io/multisig_extrinsic/1317999-2

const MULTISIG = "0x9b63daadfbe5f27e3a8810dbdf0110fcc5f7be3b4c062ee00f200bd36509b1b1";
const SIGNATORY_1 = "0xaa303ae720886af4b297843c52c04a3b1ac3f07bdf176ff7205cf317e4e5d343";
const SIGNATORY_2 = "0x04e9b1ce673275463848cbd73f08a273af6192ba67301d876061cf9876514464";
const SIGNATORY_3 = "0xecb7781c052e8798e620acafcbe8488a2d12639c5da962450ce57657f1ba2956";

subqlTest(
  "approveAsMulti derives 2-of-3 multisig address",
  1317999,
  [],
  [
    Account.create({
      id: MULTISIG,
      accountId: MULTISIG,
      isMultisig: true,
      // toHuman() emits substrate u16 as a string and the handler stores it verbatim;
      // see extractThresholdAndOtherSignatories in multisigCallHandler.ts.
      threshold: "2" as unknown as number,
    }),
    Account.create({
      id: SIGNATORY_1,
      accountId: SIGNATORY_1,
      isMultisig: false,
      threshold: 0,
    }),
    Account.create({
      id: SIGNATORY_2,
      accountId: SIGNATORY_2,
      isMultisig: false,
      threshold: 0,
    }),
    Account.create({
      id: SIGNATORY_3,
      accountId: SIGNATORY_3,
      isMultisig: false,
      threshold: 0,
    }),
    AccountMultisig.create({
      id: `${SIGNATORY_1}-${MULTISIG}`,
      multisigId: MULTISIG,
      signatoryId: SIGNATORY_1,
    }),
    AccountMultisig.create({
      id: `${SIGNATORY_2}-${MULTISIG}`,
      multisigId: MULTISIG,
      signatoryId: SIGNATORY_2,
    }),
    AccountMultisig.create({
      id: `${SIGNATORY_3}-${MULTISIG}`,
      multisigId: MULTISIG,
      signatoryId: SIGNATORY_3,
    }),
  ],
  "handleNestedCalls",
);
