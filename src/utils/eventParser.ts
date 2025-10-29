import { SubstrateEvent } from "@subql/types";

export const eventParser = {
  extrinsicIndex,
  blockNumber,
};

function extrinsicIndex(event: SubstrateEvent): number {
  return event.extrinsic ? event.extrinsic.idx : event.idx;
}

function blockNumber(event: SubstrateEvent): number {
  return event.block.block.header.number.toNumber();
}
