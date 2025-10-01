import { SubstrateEvent } from "@subql/types";
import { u8aToHex } from "@polkadot/util";
import { CreateCallVisitorBuilder, CreateCallWalk } from "subquery-call-visitor";
import { EventStatus, MultisigEvent, MultisigOperation, OperationStatus } from "../types";
import { AccountId, DispatchResult, Timepoint } from "@polkadot/types/interfaces";
import { 
  generateEventId, 
  getBlockCreated, 
  getDataFromCall, 
  getDataFromEvent, 
  getIndexCreated, 
  timestamp 
} from "./operations";

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
        return Promise.resolve();
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
export async function createMultisigEvent(
  event: SubstrateEvent, 
  operationId: string, 
  signatory: string, 
  status: EventStatus
): Promise<void> {
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
 * Extracts call hash string from event data
 * @param event - The Substrate event
 * @param index - The index of the call hash in the event data
 * @returns The call hash as a hex string
 */
export function getCallHashString(event: SubstrateEvent, index: number): string {
  const callHash = getDataFromEvent<Uint8Array>(event.event, "callHash", index);
  if (!callHash) throw new Error("Call hash not found");
  return u8aToHex(callHash);
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
  multisigAccountId: string
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

  if (!existingOperation) {
    throw new Error(
      `Operation not found for call hash: ${callHashString} on block: ${blockCreated} index: ${indexCreated} multisig account id: ${multisigAccountId}`,
    );
  }

  return existingOperation;
}

/**
 * Gets the execution result from a MultisigExecuted event
 * @param event - The Substrate event
 * @returns The operation status based on the execution result
 */
export function getExecutionResult(event: SubstrateEvent): OperationStatus {
  const result = getDataFromEvent<DispatchResult>(event.event, "result", 4);
  return result?.isOk ? OperationStatus.executed : OperationStatus.error;
}
