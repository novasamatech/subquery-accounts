import { SubstrateEvent } from "@subql/types";

import { Proxied, PureProxy } from "../../types";
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

  const pureProxy = await PureProxy.get(accountId);

  const proxy = Proxied.create({
    id: `${chainId}-${accountId}-${proxyAccountId}-${type}-${delay}`,
    chainId,
    type,
    proxyAccountId,
    accountId,
    delay,
    blockNumber: proxyData.blockNumber,
    extrinsicIndex: proxyData.extrinsicIndex,
    isPureProxy: !!pureProxy,
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

export async function handlePureProxyKiledEvent(
  event: SubstrateEvent
): Promise<void> {
  const proxyData = extractProxyEventData(event);
  
  if (!proxyData) {
    return;
  }

  const { proxyAccountId, accountId, type, delay } = proxyData;

  logger.info(`Pure Proxy Killed Event: ${JSON.stringify({
    chainId,
    type,
    proxyAccountId,
    accountId,
    delay,
  })}`);

  await PureProxy.remove(accountId);

  // Remove all proxied entities where accountId matches the killed pure proxy
  const proxiedRecords = await Proxied.getByFields([
    ["accountId", "=", accountId],
  ], { limit: 1337 });

  for (const proxied of proxiedRecords) {
    await Proxied.remove(proxied.id);
  }
}
