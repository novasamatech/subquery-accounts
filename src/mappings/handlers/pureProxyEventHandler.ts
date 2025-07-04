import { SubstrateEvent } from "@subql/types";

import { Proxied, PureProxy } from "../../types";
import { extractProxyEventData } from "../../utils/extractProxyEventData";

export async function handlePureProxyEvent(
  event: SubstrateEvent
): Promise<void> {
  const proxyData = extractProxyEventData(event);

  if (!proxyData) return;

  const { proxyAccountId, accountId, type, delay, blockNumber, extrinsicIndex } = proxyData;

  const pureProxy = PureProxy.create({
    id: accountId,
    chainId,
    blockNumber,
    extrinsicIndex,
  });

  await pureProxy.save();

  const proxy = Proxied.create({
    id: `${chainId}-${accountId}-${proxyAccountId}-${type}-${delay}`,
    chainId,
    type,
    proxyAccountId,
    accountId,
    delay,
    blockNumber,
    extrinsicIndex,
    isPureProxy: true,
  });

  await proxy.save();
}
