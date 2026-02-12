import { SubstrateEvent } from "@subql/types";
import { u8aToHex } from "@polkadot/util";
import { CreateCallVisitorBuilder, CreateCallWalk } from "subquery-call-visitor";
import { EventStatus, MultisigEvent, MultisigOperation, OperationStatus } from "../types";
import { AccountId, DispatchResult, Timepoint } from "@polkadot/types/interfaces";
import { generateEventId, getBlockCreated, getDataFromCall, getDataFromEvent, getIndexCreated, timestamp } from "./operations";

const callWalk = CreateCallWalk();

/**
 * Detects if the extrinsic contains an asMultiThreshold1 call using the visitor pattern
 * @param event - The Substrate event
 * @returns True if the extrinsic contains an asMultiThreshold1 call, false otherwise
 */
export async function isThreshold1(event: SubstrateEvent): Promise<boolean> {
  if (!event.extrinsic) return false;

  let isThreshold1Call = false;

  try {
    const visitor = CreateCallVisitorBuilder()
      .on("multisig", "asMultiThreshold1", () => {
        isThreshold1Call = true;
      })
      .on("utility", "asMultiThreshold1", () => {
        isThreshold1Call = true;
      })
      .ignoreFailedCalls(true)
      .build();

    await callWalk.walk(event.extrinsic, visitor);
  } catch (error) {
    logger.warn(`[isThreshold1] Error walking extrinsic: ${error}`);
  }

  logger.info(`[isThreshold1] Found asMultiThreshold1 call: ${isThreshold1Call}`);
  return isThreshold1Call;
}

/**
 * Creates a multisig event
 * @param event - The Substrate event
 * @param operationId - The operation ID
 * @param signatory - The signatory
 * @param status - The event status
 */
export async function createMultisigEvent(event: SubstrateEvent, operationId: string, signatory: string, status: EventStatus): Promise<void> {
  await MultisigEvent.create({
    id: generateEventId(operationId, signatory, status),
    accountId: signatory,
    status: status,
    blockCreated: getBlockCreated(event.extrinsic!),
    indexCreated: getIndexCreated(event.extrinsic!),
    multisigId: operationId,
    timestamp: timestamp(event.extrinsic!.block),
  }).save();
}

/**
 * Converts different hash-like values to a hex string
 * @param value - Value to convert
 * @returns Hex string if conversion succeeded
 */
function toHexString(value: unknown): string | undefined {
  if (!value) return;

  if (value instanceof Uint8Array) {
    return u8aToHex(value);
  }

  if (typeof value === "string" && value.startsWith("0x")) {
    return value;
  }

  if (typeof value === "object" && value && "toHex" in value && typeof value.toHex === "function") {
    return value.toHex();
  }
}

/**
 * Checks if value has the format of a 32-byte call hash
 * @param value - Hex string candidate
 * @returns True when value looks like a valid call hash
 */
function isValidCallHash(value: string | undefined): value is string {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
}

/**
 * Extracts call hash from extrinsic arguments for old runtimes where event payload has no callHash field
 * @param event - The Substrate event
 * @returns The call hash as a hex string
 */
function getCallHashFromExtrinsic(event: SubstrateEvent): string | undefined {
  const extrinsic = event.extrinsic?.extrinsic;
  if (!extrinsic) return;

  const namedCallHash = getDataFromCall<unknown>(extrinsic.method, "callHash") ?? getDataFromCall<unknown>(extrinsic.method, "call_hash");
  const namedCallHashHex = toHexString(namedCallHash);
  if (namedCallHashHex) return namedCallHashHex;

  const callArg = getDataFromCall<{ hash?: unknown }>(extrinsic.method, "call");
  const callArgHashHex = toHexString(callArg?.hash);
  if (callArgHashHex) return callArgHashHex;

  // Legacy utility.asMulti fallback: call is the 4th arg
  const callArgByIndex = extrinsic.method.args.at(3) as { hash?: unknown } | undefined;
  const callArgByIndexHex = toHexString(callArgByIndex?.hash);
  if (callArgByIndexHex) return callArgByIndexHex;
}

/**
 * Extracts call hash string from event data
 * @param event - The Substrate event
 * @param index - The index of the call hash in the event data
 * @returns The call hash as a hex string
 */
export function getCallHashString(event: SubstrateEvent, index: number): string {
  const callHashFromEvent = getDataFromEvent<unknown>(event.event, "callHash", index) ?? getDataFromEvent<unknown>(event.event, "call_hash", index);
  const callHashFromEventHex = toHexString(callHashFromEvent);
  if (isValidCallHash(callHashFromEventHex)) return callHashFromEventHex;

  const callHashFromExtrinsic = getCallHashFromExtrinsic(event);
  if (isValidCallHash(callHashFromExtrinsic)) return callHashFromExtrinsic;

  throw new Error("Call hash not found");
}

/**
 * Extracts multisig account ID from event data
 * @param event - The Substrate event
 * @param index - The index of the multisig account in the event data
 * @returns The multisig account ID as a hex string
 */
export function getMultisigAccountId(event: SubstrateEvent, index: number): string {
  const multisig = getDataFromEvent<AccountId>(event.event, "multisig", index);
  if (!multisig) throw new Error("Multisig not found");
  return multisig.toHex();
}

/**
 * Extracts signatory from event data
 * @param event - The Substrate event
 * @param fieldName - The field name containing the signatory
 * @returns The signatory as a hex string
 */
export function getSignatory(event: SubstrateEvent, fieldName: string): string {
  const signatory = getDataFromEvent<AccountId>(event.event, fieldName, 0);
  if (!signatory) throw new Error("Signatory not found");
  return signatory.toHex();
}

/**
 * Extracts block and index information from event data, including timepoint if available
 * @param event - The Substrate event
 * @returns Object containing blockCreated and indexCreated
 */
export function getBlockAndIndexFromEvent(event: SubstrateEvent): { blockCreated: number; indexCreated: number } {
  let blockCreated = getBlockCreated(event.extrinsic!);
  let indexCreated = getIndexCreated(event.extrinsic!);

  const timepoint = getDataFromEvent<Timepoint>(event.event, "timepoint", 1) || getDataFromEvent<Timepoint>(event.event, "Timepoint", 1);

  if (timepoint && timepoint.height && timepoint.index) {
    blockCreated = timepoint.height.toNumber();
    indexCreated = timepoint.index.toNumber();
  }

  return { blockCreated, indexCreated };
}

/**
 * Finds an existing multisig operation by its identifying parameters
 * @param callHashString - The call hash string
 * @param blockCreated - The block number where the operation was created
 * @param indexCreated - The extrinsic index where the operation was created
 * @param multisigAccountId - The multisig account ID
 * @returns The existing MultisigOperation
 * @throws Error if operation is not found
 */
export async function findExistingOperation(
  callHashString: string,
  blockCreated: number,
  indexCreated: number,
  multisigAccountId: string,
): Promise<MultisigOperation> {
  const [existingOperation] = await MultisigOperation.getByFields(
    [
      ["callHash", "=", callHashString],
      ["blockCreated", "=", blockCreated],
      ["indexCreated", "=", indexCreated],
      ["accountId", "=", multisigAccountId],
    ],
    { limit: 1 },
  );

  if (existingOperation) {
    return existingOperation;
  }

  // Fallback: try to find by callHash, accountId, and pending status
  logger.warn(
    `Cannot find operation by blockCreated: ${blockCreated}, indexCreated: ${indexCreated}. Trying fallback search by callHash, accountId, and pending status.`,
  );

  const [fallbackOperation] = await MultisigOperation.getByFields(
    [
      ["callHash", "=", callHashString],
      ["accountId", "=", multisigAccountId],
      ["status", "=", OperationStatus.pending],
    ],
    { limit: 1 },
  );

  if (fallbackOperation) {
    return fallbackOperation;
  }

  throw new Error(
    `Operation not found for call hash: ${callHashString} on block: ${blockCreated} index: ${indexCreated} multisig account id: ${multisigAccountId}. Also tried fallback search by callHash, accountId, and pending status.`,
  );
}

/**
 * Gets the execution result from a MultisigExecuted event
 * @param event - The Substrate event
 * @returns The operation status based on the execution result
 */
export function getExecutionResult(event: SubstrateEvent): OperationStatus {
  const result = getDataFromEvent<DispatchResult>(event.event, "result", 4) ?? getDataFromEvent<DispatchResult>(event.event, "result", 3);
  return result?.isOk ? OperationStatus.executed : OperationStatus.error;
}
