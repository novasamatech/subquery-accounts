import { SubstrateBlock, SubstrateExtrinsic } from "@subql/types";
import { EventStatus } from "../types";
import { AnyEvent } from "subquery-call-visitor";
import { AnyTuple, CallBase } from "@polkadot/types/types";
import { Option } from "@polkadot/types";

export const timestamp = (block: SubstrateBlock) => {
  return block.timestamp ? block.timestamp.getTime() / 1000 : -1;
};

export const getBlockCreated = (extrinsic: SubstrateExtrinsic): number => extrinsic.block.block.header.number.toNumber();

export const getIndexCreated = (extrinsic: SubstrateExtrinsic): number => extrinsic.idx;

export const generateOperationId = (callHash: string, address: string, block: number, index: number): string => `${callHash}-${address}-${block}-${index}`;

export const generateEventId = (operationId: string, signer: string, status: EventStatus): string => `${operationId}-${signer}-${status}`;

export const getDataFromEvent = <T>(event: AnyEvent, field: string, possibleIndex?: number): T | undefined => {
  let index = possibleIndex;

  if (event.data.names) {
    index = event.data.names?.indexOf(field);
  }

  if (index === undefined || index === -1) return;

  return event.data[index] as T;
};

const MULTISIG_EVENTS = ["NewMultisig", "MultisigApproval", "MultisigExecuted", "MultisigCancelled"];
export const getCallHashFromMultisigEvents = (events: AnyEvent[]) => {
  const multisigEvent = events.find(e => MULTISIG_EVENTS.includes(e.method));
  const data = multisigEvent?.data.toHuman() as { callHash: string } | { callHash: string; signer: string };

  if (!data.callHash) {
    throw new Error("Call hash not found in multisig events... DEATH");
  }

  return data.callHash;
};

export const getDataFromCall = <T>(call: any, field: string): T | undefined => {
  // TODO: Fix TS2345 yarn Argument of type is not assignable to parameter of type
  const typedCall = call as unknown as CallBase<AnyTuple>;

  const index = typedCall?.meta?.args?.findIndex(arg => arg.name.toString() === field);
  if (index === undefined || index === -1) return;

  if ("unwrapOr" in (typedCall.args[index] as Option<any>)) {
    return (typedCall.args[index] as Option<any>)?.unwrapOr(undefined) as T;
  }

  return typedCall.args[index] as T;
};
