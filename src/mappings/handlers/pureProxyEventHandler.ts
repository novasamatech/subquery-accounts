import { SubstrateEvent } from "@subql/types";

import { Proxied, PureProxy } from "../../types";
import { extractProxyEventData, getProxiedId } from "../../utils/extractProxyEventData";

export async function handlePureProxyEvent(
  event: SubstrateEvent
): Promise<void> {
  const proxyData = extractProxyEventData(event);

  if (!proxyData) return;

  const { proxyAccountId, accountId, type, delay, blockNumber, extrinsicIndex } = proxyData;

  const pureProxy = PureProxy.create({
    id: accountId,
    chainId,
  });

  await pureProxy.save();

  const proxied = Proxied.create({
    id: getProxiedId({ chainId, accountId, proxyAccountId, type, delay }),
    chainId,
    type,
    proxyAccountId,
    accountId,
    delay,
    blockNumber,
    extrinsicIndex,
    isPureProxy: true,
  });

  await proxied.save();
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
