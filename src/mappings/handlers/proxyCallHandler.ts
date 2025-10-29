import { VisitedCall } from "subquery-call-visitor";
import { Proxied } from "../../types";
import { u8aToHex } from "@polkadot/util";
import { decodeAddress } from "../../utils/addressesDecode";

export async function handleRemoveProxiesCall(call: VisitedCall) {
  if (!call || !call.call || !call.call.args) {
    throw new Error(`Invalid call: ${JSON.stringify(call)}`);
  }

  const callerAccountId = u8aToHex(decodeAddress(call.origin));

  while (true) {
    const proxiedBatch = await Proxied.getByFields(
      [
        ["accountId", "=", callerAccountId],
        ["chainId", "=", chainId],
      ],
      { limit: 100 },
    );

    if (proxiedBatch.length === 0) {
      break;
    }

    logger.info(`Removing ${proxiedBatch.length} proxy records for account ${callerAccountId}`);

    for (const proxied of proxiedBatch) {
      await Proxied.remove(proxied.id);
    }
  }

  logger.info(`Completed removing all proxies for account ${callerAccountId}`);
}
