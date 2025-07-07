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

  // Fetch and remove in batches to ensure all records are deleted, even when exceeding the batch size
  while (true) {
    const proxiedBatch = await Proxied.getByFields(
      [
        ["accountId", "=", accountId],
        ["chainId", "=", chainId],
      ],
      { limit: 100 }
    );

    if (proxiedBatch.length === 0) {
      break;
    }

    for (const proxied of proxiedBatch) {
      await Proxied.remove(proxied.id);
    }
  }
}
