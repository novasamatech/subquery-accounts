import { SubstrateEvent } from "@subql/types";

import { Proxied, PureProxy } from "../../types";
import { extractProxyEventData, getProxiedId, getPureProxyId } from "../../utils/extractProxyEventData";

export async function handleProxyEvent(event: SubstrateEvent): Promise<void> {
  const proxyData = extractProxyEventData(event);

  if (!proxyData) {
    return;
  }

  const { proxy: proxyAccountId, proxied: accountId, type, delay } = proxyData;
  const typeString = type.toHuman() as string;

  logger.info(
    `Proxy Add Event: ${JSON.stringify({
      type,
      proxyAccountId,
      accountId,
      delay,
    })}`,
  );

  const pureProxy = await PureProxy.get(getPureProxyId({ chainId, pure: accountId }));

  const proxied = Proxied.create({
    id: getProxiedId({ chainId, proxied: accountId, proxy: proxyAccountId, type: typeString, delay }),
    chainId,
    type: typeString,
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

  const { proxy: proxyAccountId, proxied: accountId, type, delay } = proxyData;
  const typeString = type.toHuman() as string;

  logger.info(
    `Proxy Remove Event: ${JSON.stringify({
      chainId,
      type,
      proxyAccountId,
      accountId,
      delay,
    })}`,
  );

  await Proxied.remove(getProxiedId({ chainId, proxied: accountId, proxy: proxyAccountId, type: typeString, delay }));
}
