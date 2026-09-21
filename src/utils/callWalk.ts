import type { Enum, Struct, Tuple } from "@polkadot/types-codec";
import type { AnyTuple, CallBase } from "@polkadot/types/types";
import { CreateCallWalk, DefaultKnownNodes, EventCountingContext, NestedCallNode, NodeContext } from "subquery-call-visitor";
import { getDataFromCall, getDataFromEvent } from "./operations";

type Call = CallBase<AnyTuple>;

function metaTransaction(call: Call): Struct {
  const meta = getDataFromCall<Struct>(call, "metaTx") ?? getDataFromCall<Struct>(call, "meta_tx");
  if (!meta) throw new Error("metaTx.dispatch has no meta_tx");
  return meta;
}

function metaOrigin(call: Call, meta: Struct): string {
  const lookup = call.registry.lookup;
  const argument = call.meta.args.find(field => ["meta_tx", "metaTx"].includes(field.name.toString()));
  const type = argument && call.registry.getDefinition(argument.type.toString());
  if (!type || !call.registry.isLookupType(type)) throw new Error("metaTx argument has no portable metadata type");
  const fields = lookup.getSiType(type).def.asComposite.fields;
  const extension = fields.find(field => field.name.unwrapOrDefault().eq("extension"));
  if (!extension) throw new Error("metaTx has no extension metadata");
  const types = lookup.getSiType(extension.type).def.asTuple;
  const index = types.findIndex(type => lookup.getSiType(type).path.map(part => part.toString()).join("::") ===
    "pallet_verify_signature::extension::VerifySignature");
  const verification = meta.getT<Tuple>("extension")[index] as Enum | undefined;
  const account = verification?.type === "Signed" ? (verification.value as Struct).get("account") : undefined;
  if (!account) throw new Error("Unsupported metaTx authorization: expected VerifySignature.Signed");
  return account.toString();
}

function dispatchedEvent() {
  const completed = api.events.metaTx?.Dispatched;
  if (!completed) throw new Error("metaTx.Dispatched is missing from metadata");
  return completed;
}

class MetaTxNode implements NestedCallNode {
  canVisit(call: Call): boolean {
    return call.section === "metaTx" && call.method === "dispatch";
  }

  endExclusiveToSkipInternalEvents(call: Call, context: EventCountingContext): number {
    const item = context.eventQueue.peekItemFromEnd([dispatchedEvent()], context.endExclusive);
    if (!item) throw new Error("Successful metaTx.dispatch has no Dispatched event");
    const [event, index] = item;
    const result = getDataFromEvent<Enum>(event, "result", 0);
    return result?.type === "Ok"
      ? context.endExclusiveToSkipInternalEvents(metaTransaction(call).getT<Call>("call"), index)
      : index;
  }

  async visit(call: Call, context: NodeContext): Promise<void> {
    if (!context.callSucceeded) return;
    const event = context.eventQueue.takeFromEnd(dispatchedEvent());
    if (!event) throw new Error("Successful metaTx.dispatch has no Dispatched event");
    // The wrapper succeeds even when the authorized inner call fails.
    if (getDataFromEvent<Enum>(event, "result", 0)?.type !== "Ok") return;
    const meta = metaTransaction(call);
    await context.nestedVisit({
      call: meta.getT<Call>("call"),
      origin: metaOrigin(call, meta),
      success: true,
      events: context.eventQueue.all(),
      extrinsic: context.extrinsic,
    });
  }
}

export const callWalk = CreateCallWalk([...DefaultKnownNodes, new MetaTxNode()]);
