import assert from "assert";
import { SubstrateEvent } from "@subql/types";

import { PureProxy } from "../types";

export async function handleEvent(event: SubstrateEvent): Promise<void> {
  const {
    event: {
      data: [accountId, proxyAccountId, proxyType, delay],
    },
  } = event;

  const pureProxy = PureProxy.create({
    id: accountId.toHex(),
    proxyAccountId: proxyAccountId.toHex(),
    proxyType: proxyType.toString(),
    delay: Number(delay.toString()),
  });

  await pureProxy.save();
}
