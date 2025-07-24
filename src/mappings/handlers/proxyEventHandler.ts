import { SubstrateEvent } from "@subql/types";

import { Proxied, PureProxy } from "../../types";
import { extractProxyEventData, getProxiedId } from "../../utils/extractProxyEventData";

export async function handleProxyEvent(event: SubstrateEvent): Promise<void> {
  const proxyData = extractProxyEventData(event);

  if (!proxyData) {
    return;
  }

  const { proxyAccountId, accountId, type, delay } = proxyData;

  logger.info(
    `Proxy Add Event: ${JSON.stringify({
      type,
      proxyAccountId,
      accountId,
      delay,
    })}`,
  );

  const pureProxy = await PureProxy.get(accountId);

  const proxied = Proxied.create({
    id: getProxiedId({ chainId, accountId, proxyAccountId, type, delay }),
    chainId,
    type,
    proxyAccountId,
    accountId,
    delay,
    blockNumber: proxyData.blockNumber,
    extrinsicIndex: proxyData.extrinsicIndex,
    isPureProxy: !!pureProxy,
  });

  await proxied.save();
}

export async function handleProxyRemovedEvent(event: SubstrateEvent): Promise<void> {
  const proxyData = extractProxyEventData(event);

  if (!proxyData) {
    return;
  }

  const { proxyAccountId, accountId, type, delay } = proxyData;

  logger.info(
    `Proxy Remove Event: ${JSON.stringify({
      chainId,
      type,
      proxyAccountId,
      accountId,
      delay,
    })}`,
  );

  await Proxied.remove(getProxiedId({ chainId, accountId, proxyAccountId, type, delay }));
}
