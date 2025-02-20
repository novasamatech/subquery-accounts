import { SubstrateBlock, SubstrateExtrinsic } from "@subql/types";
import { EventStatus } from "../types";

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
