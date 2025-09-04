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
      // we're skipping large batches, something terrible happens inside anyway
      context.stop();
    }
  })
  .on("multisig", "asMulti", handleMultisigCall)
  .on("multisig", "approveAsMulti", handleMultisigCall)
  .on("multisig", "cancelAsMulti", handleMultisigCall)
  .on("multisig", "asMultiThreshold1", handleMultisigCall)

  .on("system", "remark", handleRemark)
  .on("system", "remarkWithEvent", handleRemark)
  .on("proxy", "removeProxies", handleRemoveProxiesCall)
  .ignoreFailedCalls(true)
  .build();

export const handleNestedCalls = (extrinsic: SubstrateExtrinsic) => {
  return callWalk.walk(extrinsic, visitor);
};

// export function handleProxyProxy(extrinsic: SubstrateExtrinsic) {
//   return Promise.all([handleRemark(extrinsic), handleProxyCall(extrinsic), handleMultisigCall(extrinsic)]);
// }

// export function handleMultisig(extrinsic: SubstrateExtrinsic) {
//   return Promise.all([handleMultisigCall(extrinsic), handleRemark(extrinsic), handleProxyCall(extrinsic)]);
// }

// export function handleBatch(extrinsic: SubstrateExtrinsic) {
//   return Promise.all([handleRemark(extrinsic), handleProxyCall(extrinsic), handleMultisigCall(extrinsic)]);
// }
