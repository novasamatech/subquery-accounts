import { SubstrateEvent } from "@subql/types";

import { Proxied, PureProxy } from "../../types";
import { extractProxyEventData, getProxiedId, getPureProxyId } from "../../utils/extractProxyEventData";

import { findPureBlockNumber } from "../../utils";
import { extractPureProxyEventData } from "../../utils/extractPureProxyEventData";

export async function handlePureProxyEvent(event: SubstrateEvent): Promise<void> {
  const proxyData = extractPureProxyEventData(event);

  logger.info(`Pure Proxy Event: ${JSON.stringify(proxyData)}`);
  if (!proxyData) return;

  const { spawner, pure, type, disambiguationIndex, delay, blockNumber, extrinsicIndex } = proxyData;

  const typeString = type.toHuman() as string;
  const typeU8a = type.toU8a();

  const pureBlockNumber = await findPureBlockNumber({
    spawner,
    pure,
    type: typeU8a,
    disambiguationIndex,
    blockNumber,
    extrinsicIndex,
  });

  const pureProxy = PureProxy.create({
    id: getPureProxyId({ chainId, pure }),
    chainId,
    accountId: pure,
    spawner,
    disambiguationIndex,
  });

  await pureProxy.save();

  const proxied = Proxied.create({
    id: getProxiedId({ chainId, delegator: pure, delegatee: spawner, type: typeString, delay }),
    chainId,
    type: typeString,
    proxyAccountId: spawner,
    accountId: pure,
    delay,
    blockNumber: pureBlockNumber,
    extrinsicIndex,
    isPureProxy: true,
    disambiguationIndex,
    spawner,
  });

  await proxied.save();
}

export async function handlePureProxyKilledEvent(event: SubstrateEvent): Promise<void> {
  const proxyData = extractProxyEventData(event);

  if (!proxyData) {
    return;
  }

  const { delegatee: proxyAccountId, delegator: accountId, type, delay } = proxyData;

  logger.info(
    `Pure Proxy Killed Event: ${JSON.stringify({
      chainId,
      type,
      proxyAccountId,
      accountId,
      delay,
    })}`,
  );

  await PureProxy.remove(accountId);

  // Fetch and remove in batches to ensure all records are deleted, even when exceeding the batch size
  while (true) {
    const proxiedBatch = await Proxied.getByFields(
      [
        ["accountId", "=", accountId],
        ["chainId", "=", chainId],
      ],
      { limit: 100 },
    );

    if (proxiedBatch.length === 0) {
      break;
    }

    for (const proxied of proxiedBatch) {
      await Proxied.remove(proxied.id);
    }
  }
}
