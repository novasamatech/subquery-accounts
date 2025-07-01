import { SubstrateEvent } from "@subql/types";

import { PureProxy, Proxy } from "../../types";
import { extractProxyEventData } from "../../utils/extractProxyEventData";

export async function handlePureProxyEvent(
  event: SubstrateEvent
): Promise<void> {
  const proxyData = extractProxyEventData(event);

  if (!proxyData) return;

  const { proxiedAccountId, accountId, type, delay, blockNumber, extrinsicIndex } = proxyData;

  const pureProxy = PureProxy.create({
    id: proxiedAccountId,
    blockNumber,
    extrinsicIndex,
  });

  await pureProxy.save();

  const proxy = Proxy.create({
    id: `${chainId}-${proxiedAccountId}-${accountId}-${type}-${delay}`,
    chainId,
    type,
    proxiedAccountId,
    accountId,
    delay,
    blockNumber: proxyData.blockNumber,
    extrinsicIndex: proxyData.extrinsicIndex,
    isPureProxy: true,
  });

  await proxy.save();
}
