import { SubstrateBlock, SubstrateExtrinsic } from "@subql/types";
import { EventStatus } from "../types";
import { AnyEvent } from "subquery-call-visitor";
import { AnyTuple, CallBase } from "@polkadot/types/types";
import { Option } from "@polkadot/types";

export const timestamp = (block: SubstrateBlock): bigint => {
  return BigInt(
    Math.round(block.timestamp ? block.timestamp.getTime() / 1000 : -1),
  );
}

export const formatStringToNumber = (value: string): number => Number(value.replaceAll(',', ''));

export const getBlockCreated = (extrinsic: SubstrateExtrinsic): number => 
  extrinsic.block.block.header.number.toNumber();

export const getIndexCreated = (extrinsic: SubstrateExtrinsic): number => extrinsic.idx;

export const generateOperationId = (callHash: string, address: string, block: number, index: number): string =>
  `${callHash}-${address}-${block}-${index}`;

export const generateEventId = (operationId: string, signer: string, status: EventStatus): string =>
  `${operationId}-${signer}-${status}`;

export const getDataFromEvent = <T>(event: AnyEvent, field: string, possibleIndex?: number): T | undefined => {
  let index = possibleIndex;

  if (event.data.names) {
    index = event.data.names?.indexOf(field);
  }

  if (index === undefined || index === -1) return;
  
  return event.data[index] as T;  
}

export const getDataFromCall = <T>(call: CallBase<AnyTuple>, field: string): T | undefined => {
  const index = call.meta.args.findIndex(arg => arg.name.toString() === field);
  if (index === undefined || index === -1) return;
  
  if ('unwrapOr' in (call.args[index] as Option<any>)) {
    return (call.args[index] as Option<any>)?.unwrapOr(undefined) as T
  }

  return call.args[index] as T;
}
