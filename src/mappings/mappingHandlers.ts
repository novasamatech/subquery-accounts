import { SubstrateEvent, SubstrateExtrinsic } from "@subql/types";

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

export async function handleMultisigCall(
  extrinsic: SubstrateExtrinsic
): Promise<void> {
  console.log(extrinsic.block.toJSON());
  // const record = new CallEntity(extrinsic.block.block.header.hash.toString());
  // record.field4 = extrinsic.block.timestamp;
  // await record.save();
}
