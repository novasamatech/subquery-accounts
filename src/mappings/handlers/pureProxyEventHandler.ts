import { SubstrateEvent } from "@subql/types";

import { Proxied, PureProxy } from "../../types";
import { extractProxyEventData, getProxiedId, getPureProxyId } from "../../utils/extractProxyEventData";

import { calculatePureAccount } from "../../utils";
import { extractPureProxyEventData } from "../../utils/extractPureProxyEventData";

export async function handlePureProxyEvent(event: SubstrateEvent): Promise<void> {
  const proxyData = extractPureProxyEventData(event);

  logger.info(`Pure Proxy Event: ${JSON.stringify(proxyData)}`);
  if (!proxyData) return;

  const { who, pure, type, disambiguationIndex, delay, blockNumber, extrinsicIndex } = proxyData;

  const typeString = type.toHuman() as string;
  const typeU8a = type.toU8a();

  const pureAccount = calculatePureAccount({
    who: who,
    proxyType: typeU8a,
    index: disambiguationIndex,
    maybeWhen: { blockHeight: blockNumber, extrinsicIndex },
  });

  if (pure !== pureAccount) {
    const validationData = await api.query?.["parachainSystem"]?.["validationData"]?.();
    const json = validationData?.toJSON() as { relayParentNumber: number };
    const relayParentNumber = json?.relayParentNumber ?? 0;

    const pureAccountRelayParent = calculatePureAccount({
      who: who,
      proxyType: typeU8a,
      index: disambiguationIndex,
      maybeWhen: { blockHeight: relayParentNumber, extrinsicIndex },
    });
  
    if (pure !== pureAccountRelayParent) {
      throw new Error(`Who ${who} is not the pure account ${pureAccount} or the pure account relay parent ${pureAccountRelayParent}`);
    }
  }

  const pureProxy = PureProxy.create({
    id: getPureProxyId({ chainId, delegator: pure }),
    chainId,
    accountId: pure,
  });

  await pureProxy.save();

  const proxied = Proxied.create({
    id: getProxiedId({ chainId, delegator: pure, delegatee: who, type: typeString, delay }),
    chainId,
    type: typeString,
    proxyAccountId: who,
    accountId: pure,
    delay,
    blockNumber,
    extrinsicIndex,
    isPureProxy: true,
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
