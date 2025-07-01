import { SubstrateEvent } from "@subql/types";

import { Proxied } from "../../types";
import { extractProxyEventData } from "../../utils/extractProxyEventData";

export async function handleProxyEvent(
  event: SubstrateEvent
): Promise<void> {
  const proxyData = extractProxyEventData(event);
  
  if (!proxyData) {
    return;
  }

  const { proxyAccountId, accountId, type, delay } = proxyData;

  logger.info(`Proxy Add Event: ${JSON.stringify({
    type,
    proxyAccountId,
    accountId,
    delay,
  })}`);

  const proxy = Proxied.create({
    id: `${chainId}-${accountId}-${proxyAccountId}-${type}-${delay}`,
    chainId,
    type,
    proxyAccountId,
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

  const { proxyAccountId, accountId, type, delay } = proxyData;

  logger.info(`Proxy Remove Event: ${JSON.stringify({
    chainId,
    type,
    proxyAccountId,
    accountId,
    delay,
  })}`);

  await Proxied.remove(`${chainId}-${accountId}-${proxyAccountId}-${type}-${delay}`);
}
