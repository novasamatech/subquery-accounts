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
  });

  await pureProxy.save();
}
