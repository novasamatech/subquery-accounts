import { SubstrateEvent } from "@subql/types";
import { PureProxy, Proxied } from "../../types";
import { getProxiedId, getPureProxyId } from "../../utils/extractProxyEventData";

const CHAIN_MIGRATIONS = {
  "0x91b171bb158e2d3848fa23a9f1c25182fb8e20313b2c1eb49219da7a70ce90c3": "0x68d56f15f85d3136970ec16946040bc1752654e906147f7e43e9d539d7c3de2f",
  "0xb0a8d493285c2df73290dfb7e61f870f17b41801197a149ca93654499ea3dafe": "0x48239ef607d7928874027a43a67689209727dfb3d3dc5e5b03a39bdc2eda771a",
  "0xe143f23803ac50e8f6f8e62695d1ce9e4e1d68aa36c1cd2cfd15340213f3423e": "0x67f9723393ef76214df0118c34bbbd3dbebc8ed46a10973a8c969d48fe7598c9",
} as const;

const CONFIG = {
  BATCH_SIZE: 100,
  DELETE_ORIGINALS: true,
} as const;

const BATCH_SIZE = CONFIG.BATCH_SIZE;
const DELETE_ORIGINALS = CONFIG.DELETE_ORIGINALS;

type Stats = { migrated: number; deleted: number };

export async function handleAssetHubMigrationEvent(event: SubstrateEvent): Promise<void> {
  const sourceChainId = chainId;
  const targetChainId = CHAIN_MIGRATIONS[sourceChainId as keyof typeof CHAIN_MIGRATIONS];

  if (!targetChainId) {
    logger.error(`Unsupported migration source: ${sourceChainId}`);
    return;
  }

  logger.info(`Starting Asset Hub migration: ${sourceChainId} → ${targetChainId}`);

  const pureProxyStats = await migratePureProxyEntities(sourceChainId, targetChainId);
  const proxiedStats = await migrateProxiedEntities(sourceChainId, targetChainId);

  const totalMigrated = pureProxyStats.migrated + proxiedStats.migrated;
  const totalDeleted = pureProxyStats.deleted + proxiedStats.deleted;

  logger.info(`Migration completed: migrated=${totalMigrated}, deleted=${totalDeleted}`);
}

async function migratePureProxyEntities(sourceChainId: string, targetChainId: string): Promise<Stats> {
  logger.info(`Migrating PureProxy entities: ${sourceChainId} → ${targetChainId}`);
  let offset = 0;
  const stats: Stats = { migrated: 0, deleted: 0 };

  while (true) {
    const proxies = await PureProxy.getByChainId(sourceChainId, { limit: BATCH_SIZE, offset });
    if (proxies.length === 0) break;

    for (const proxy of proxies) {
      const newId = getPureProxyId({
        chainId: targetChainId,
        pure: proxy.accountId as `0x${string}`,
      });

      if (!(await PureProxy.get(newId))) {
        await PureProxy.create({
          ...proxy,
          id: newId,
          chainId: targetChainId,
        }).save();
        stats.migrated += 1;
      }

      if (DELETE_ORIGINALS) {
        await PureProxy.remove(proxy.id);
        stats.deleted += 1;
      }
    }
    logger.info(`PureProxy progress: migrated=${stats.migrated}, deleted=${stats.deleted}`);
    offset += BATCH_SIZE;
  }
  logger.info(`PureProxy migration finished: migrated=${stats.migrated}, deleted=${stats.deleted}`);
  return stats;
}

async function migrateProxiedEntities(sourceChainId: string, targetChainId: string): Promise<Stats> {
  logger.info(`Migrating Proxied entities: ${sourceChainId} → ${targetChainId}`);
  let offset = 0;
  const stats: Stats = { migrated: 0, deleted: 0 };

  while (true) {
    const entities = await Proxied.getByChainId(sourceChainId, { limit: BATCH_SIZE, offset });
    if (entities.length === 0) break;

    for (const ent of entities) {
      const newId = getProxiedId({
        chainId: targetChainId,
        proxied: ent.accountId as `0x${string}`,
        proxy: ent.proxyAccountId as `0x${string}`,
        type: ent.type,
        delay: ent.delay,
      });

      if (!(await Proxied.get(newId))) {
        await Proxied.create({
          ...ent,
          id: newId,
          chainId: targetChainId,
        }).save();
        stats.migrated += 1;
      }

      if (DELETE_ORIGINALS) {
        await Proxied.remove(ent.id);
        stats.deleted += 1;
      }
    }
    logger.info(`Proxied progress: migrated=${stats.migrated}, deleted=${stats.deleted}`);
    offset += BATCH_SIZE;
  }
  logger.info(`Proxied migration finished: migrated=${stats.migrated}, deleted=${stats.deleted}`);
  return stats;
}
