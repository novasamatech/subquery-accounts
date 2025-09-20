import { SubstrateEvent } from "@subql/types";

import { Proxied, PureProxy } from "../../types";
import { extractProxyEventData, getProxiedId, getPureProxyId } from "../../utils/extractProxyEventData";

export async function handleProxyEvent(event: SubstrateEvent): Promise<void> {
  const proxyData = extractProxyEventData(event);

  if (!proxyData) {
    return;
  }

  const { delegatee: proxyAccountId, delegator: accountId, type, delay } = proxyData;
  const typeString = type.toHuman() as string;

  logger.info(
    `Proxy Add Event: ${JSON.stringify({
      type,
      proxyAccountId,
      accountId,
      delay,
    })}`,
  );

  const pureProxy = await PureProxy.get(getPureProxyId({ chainId, delegator: accountId }));

  const proxied = Proxied.create({
    id: getProxiedId({ chainId, delegator: accountId, delegatee: proxyAccountId, type: typeString, delay }),
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

  const { delegatee: proxyAccountId, delegator: accountId, type, delay } = proxyData;
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

  await Proxied.remove(getProxiedId({ chainId, delegator: accountId, delegatee: proxyAccountId, type: typeString, delay }));
}
