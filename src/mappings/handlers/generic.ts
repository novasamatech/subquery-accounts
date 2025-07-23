import { SubstrateExtrinsic } from "@subql/types";
import { handleMultisigCall, handleMultisigInProxy } from "./multisigCallHandler";
import { handleRemark } from "./multisigRemarkHandler";

export function handleProxyProxy(extrinsic: SubstrateExtrinsic) {
  return Promise.all([handleMultisigInProxy(extrinsic), handleRemark(extrinsic)]);
}

export function handleMultisig(extrinsic: SubstrateExtrinsic) {
  return Promise.all([handleMultisigCall(extrinsic), handleRemark(extrinsic)]);
}

export function handleBatch(extrinsic: SubstrateExtrinsic) {
  return Promise.all([handleRemark(extrinsic)]);
}
