import { SubstrateEvent } from "@subql/types";

import { Proxy } from "../../types";
import { extractProxyEventData } from "../../utils/extractProxyEventData";

export async function handleProxyEvent(
  event: SubstrateEvent
): Promise<void> {
  const proxyData = extractProxyEventData(event);
  
  if (!proxyData) {
    return;
  }

  const { proxiedAccountId, accountId, type, delay } = proxyData;

  logger.info(`Proxy Add Event: ${JSON.stringify({
    type,
    proxiedAccountId,
    accountId,
    delay,
  })}`);

  const proxy = Proxy.create({
    id: `${chainId}-${proxiedAccountId}-${accountId}-${type}-${delay}`,
    chainId,
    type,
    proxiedAccountId,
    accountId,
    delay,
    blockNumber: proxyData.blockNumber,
    extrinsicIndex: proxyData.extrinsicIndex,
    isPureProxy: false,
  });

  await proxy.save();
}

export async function handleProxyRemovedEvent(
  event: SubstrateEvent
): Promise<void> {
  const proxyData = extractProxyEventData(event);
  
  if (!proxyData) {
    return;
  }

  const { proxiedAccountId, accountId, type, delay } = proxyData;

  logger.info(`Proxy Remove Event: ${JSON.stringify({
    chainId,
    type,
    proxiedAccountId,
    accountId,
    delay,
  })}`);

  await Proxy.remove(`${chainId}-${proxiedAccountId}-${accountId}-${type}-${delay}`);
}
