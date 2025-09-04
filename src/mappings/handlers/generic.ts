import { SubstrateExtrinsic } from "@subql/types";
import { handleMultisigCall } from "./multisigCallHandler";
import { handleRemark } from "./multisigRemarkHandler";
import { handleRemoveProxiesCall } from "./proxyCallHandler";
import { CreateCallVisitorBuilder, CreateCallWalk } from "subquery-call-visitor";

const callWalk = CreateCallWalk();

const visitor = CreateCallVisitorBuilder()
  .on("utility", ["batch", "batchAll", "forceBatch"], (extrinsic, context) => {
    const calls = extrinsic.call.args.at(0);
    if (Array.isArray(calls) && calls.length > 100) {
    const maxLength = 10_000;
    const calls = extrinsic.call.args[0];
    // we're skipping large batches, something terrible happens inside anyway
    if (Array.isArray(calls) && calls.length > maxLength || extrinsic.events?.length > maxLength) {
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
