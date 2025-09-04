import { SubstrateExtrinsic } from "@subql/types";
import { handleMultisigCall } from "./multisigCallHandler";
import { handleRemark } from "./multisigRemarkHandler";
import { handleRemoveProxiesCall } from "./proxyCallHandler";
import { CreateCallVisitorBuilder, CreateCallWalk } from "subquery-call-visitor";

const callWalk = CreateCallWalk();

const visitor = CreateCallVisitorBuilder()
  .on("utility", ["batch", "batchAll", "forceBatch"], (extrinsic, context) => {
    const calls = extrinsic.call.args.at(0);
    const maxLength = 10_000;

    if ((Array.isArray(calls) && calls.length > maxLength) || extrinsic.events?.length > maxLength) {
      context.stop();
    }
  })
  .on("multisig", "asMulti", handleMultisigCall)
  .on("multisig", "approveAsMulti", handleMultisigCall)
  .on("multisig", "cancelAsMulti", handleMultisigCall)
  .on("multisig", "asMultiThreshold1", handleMultisigCall)

  .on("system", "remarkWithEvent", handleRemark)
  .on("proxy", "removeProxies", handleRemoveProxiesCall)
  .ignoreFailedCalls(true)
  .build();

export const handleNestedCalls = (extrinsic: SubstrateExtrinsic) => {
  return callWalk.walk(extrinsic, visitor);
};
