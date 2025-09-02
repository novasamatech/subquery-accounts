import { SubstrateExtrinsic } from "@subql/types";
import { handleMultisigCall } from "./multisigCallHandler";
import { handleRemark } from "./multisigRemarkHandler";
import { handleProxyCall } from "./proxyCallHandler";

export function handleProxyProxy(extrinsic: SubstrateExtrinsic) {
  return Promise.all([handleRemark(extrinsic), handleProxyCall(extrinsic)]);
}

export function handleMultisig(extrinsic: SubstrateExtrinsic) {
  return Promise.all([handleMultisigCall(extrinsic), handleRemark(extrinsic), handleProxyCall(extrinsic)]);
}

export function handleBatch(extrinsic: SubstrateExtrinsic) {
  return Promise.all([handleRemark(extrinsic), handleProxyCall(extrinsic)]);
}
