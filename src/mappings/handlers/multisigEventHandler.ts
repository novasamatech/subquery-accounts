import { SubstrateEvent, SubstrateExtrinsic } from "@subql/types";
import { CreateCallVisitorBuilder, CreateCallWalk, VisitedCall } from "subquery-call-visitor";
import { EventStatus, MultisigOperation, OperationStatus } from "../../types";
import { generateOperationId, getDataFromCall, timestamp } from "../../utils/operations";
import {
  createMultisigEvent,
  getCallHashString,
  getMultisigAccountId,
  getSignatory,
  getBlockAndIndexFromEvent,
  findExistingOperation,
  getExecutionResult,
  isThreshold1
} from "../../utils/multisigHelpers";

import { AnyTuple, CallBase } from "@polkadot/types/types";


const callWalk = CreateCallWalk();

/**
 * Creates a multisig visitor with the specified call handler
 * @param handleCall - Function to handle multisig calls
 * @returns Configured visitor
 */
function createMultisigVisitor(handleCall: (visitedCall: VisitedCall) => Promise<void>) {
  return CreateCallVisitorBuilder()
    .on("utility", ["batch", "batchAll", "forceBatch"], (extrinsic, context) => {
      const calls = extrinsic.call.args.at(0);
      if (Array.isArray(calls) && calls.length > 100) {
        // we're skipping large batches, something terrible happens inside anyway
        context.stop();
      }
    })
    .on("multisig", "asMulti", handleCall)
    .on("multisig", "asMultiThreshold1", handleCall)
    .ignoreFailedCalls(true)
    .build();
}

/**
 * Counts the number of multisig calls in an extrinsic
 * @param extrinsic - The extrinsic to analyze
 * @returns Number of multisig calls found
 */
async function calculateMultiCalls(extrinsic: SubstrateExtrinsic): Promise<number> {
  let count = 0;

  const handleCall = (_: VisitedCall) => {
    count++;
    return Promise.resolve();
  };

  const visitor = createMultisigVisitor(handleCall);
  await callWalk.walk(extrinsic, visitor);
  return count;
}

function createHandleCall(operation: MultisigOperation, callHash: string, multisigCallsWithCallData: number) {
  return async (visitedCall: VisitedCall) => {
    const call = getDataFromCall<CallBase<AnyTuple>>(visitedCall.call, "call");

    if (!call) {
      throw new Error("Call not found");
    }

    if (multisigCallsWithCallData >= 2 && call.hash.toHex() !== callHash) {
      return;
    }

    let callData = call?.toHex() || operation?.callData;
    let method = call?.method || operation?.method;
    let section = call?.section || operation?.section;

    operation.callData = callData;
    operation.method = method;
    operation.section = section;
  };
}


async function populateOperationWithCallData(operation: MultisigOperation, callHashString: string, event: SubstrateEvent): Promise<void> {
  const count = await calculateMultiCalls(event.extrinsic!);

  const handleCall = createHandleCall(operation, callHashString, count);
  const multisigVisitor = createMultisigVisitor(handleCall);

  await callWalk.walk(event.extrinsic!, multisigVisitor);
}

export async function handleNewMultisigEvent(event: SubstrateEvent) {
  if (!event.extrinsic) throw new Error("Extrinsic not found");

  const callHashString = getCallHashString(event, 2);
  const multisigAccountId = getMultisigAccountId(event, 1);

  const { blockCreated, indexCreated } = getBlockAndIndexFromEvent(event);

  const operationId = generateOperationId(callHashString, multisigAccountId, blockCreated, indexCreated);

  const signatory = getSignatory(event, "approving");

  const newOperation = await MultisigOperation.create({
    id: operationId,
    chainId: chainId,
    callHash: callHashString,
    status: OperationStatus.pending,
    accountId: multisigAccountId,
    depositor: signatory,
    blockCreated: blockCreated,
    indexCreated: indexCreated,
    timestamp: timestamp(event.extrinsic.block),
  });

  await createMultisigEvent(event, newOperation.id, signatory, EventStatus.approve);
  await populateOperationWithCallData(newOperation, callHashString, event);
  await newOperation.save();
}

export async function handleMultisigApprovedEvent(event: SubstrateEvent) {
  if (!event.extrinsic) throw new Error("Extrinsic not found");

  const callHashString = getCallHashString(event, 3);
  const multisigAccountId = getMultisigAccountId(event, 2);
  const { blockCreated, indexCreated } = getBlockAndIndexFromEvent(event);
  const existingOperation = await findExistingOperation(callHashString, blockCreated, indexCreated, multisigAccountId);
  const signatory = getSignatory(event, "approving");

  const newOperation = await MultisigOperation.create({
    ...existingOperation,
  });

  await createMultisigEvent(event, newOperation.id, signatory, EventStatus.approve);
  await populateOperationWithCallData(newOperation, callHashString, event);
  await newOperation.save();
}


export async function handleMultisigExecutedEvent(event: SubstrateEvent) {
  if (!event.extrinsic) throw new Error("Extrinsic not found");

  const callHashString = getCallHashString(event, 3);
  const multisigAccountId = getMultisigAccountId(event, 2);
  const { blockCreated, indexCreated } = getBlockAndIndexFromEvent(event);
  const isThresholdOne = await isThreshold1(event);
  const finalStatus = getExecutionResult(event);
  const signatory = getSignatory(event, "approving");

  let operation: MultisigOperation;

  if (isThresholdOne) {
    const operationId = generateOperationId(callHashString, multisigAccountId, blockCreated, indexCreated);
    operation = await MultisigOperation.create({
      id: operationId,
      chainId: chainId,
      callHash: callHashString,
      status: finalStatus,
      accountId: multisigAccountId,
      depositor: signatory,
      blockCreated: blockCreated,
      indexCreated: indexCreated,
      timestamp: timestamp(event.extrinsic.block),
    });
  } else {
    const existingOperation = await findExistingOperation(
      callHashString,
      blockCreated,
      indexCreated,
      multisigAccountId
    );
    operation = await MultisigOperation.create({
      ...existingOperation,
      status: finalStatus,
    });
  }

  await createMultisigEvent(event, operation.id, signatory, EventStatus.approve);
  await populateOperationWithCallData(operation, callHashString, event);
  await operation.save();
}

export async function handleMultisigCancelledEvent(event: SubstrateEvent) {
  if (!event.extrinsic) throw new Error("Extrinsic not found");

  const callHashString = getCallHashString(event, 3);
  const multisigAccountId = getMultisigAccountId(event, 2);
  const { blockCreated, indexCreated } = getBlockAndIndexFromEvent(event);
  const existingOperation = await findExistingOperation(callHashString, blockCreated, indexCreated, multisigAccountId);
  const signatory = getSignatory(event, "cancelling");

  const newOperation = await MultisigOperation.create({
    ...existingOperation,
    status: OperationStatus.cancelled,
  });

  await createMultisigEvent(event, newOperation.id, signatory, EventStatus.reject);
  await newOperation.save();
}
