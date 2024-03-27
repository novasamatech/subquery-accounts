import assert from "assert";
import { SubstrateEvent } from "@subql/types";

import { PureProxy } from "../types";

export async function handleEvent(event: SubstrateEvent): Promise<void> {
  const {
    event: {
      data: [accountId],
    },
  } = event;

  const pureProxy = PureProxy.create({
    id: accountId.toHex(),
    blockNumber: blockNumber(event),
    extrinsicIndex: extrinsicIndex(event),
  });

  await pureProxy.save();
}

function extrinsicIndex(event: SubstrateEvent): number {
  return event.extrinsic ? event.extrinsic.idx : event.idx;
}

function blockNumber(event: SubstrateEvent): number {
  return event.block.block.header.number.toNumber();
}
