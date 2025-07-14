import { Bytes } from "@polkadot/types";
import { Extrinsic } from "@polkadot/types/interfaces";

export const isJsonStringArgs = (extrinsic: Extrinsic) => {
  //123 is {  and  125 is }        :)
  return (extrinsic.args[0] as Bytes)?.at(-1) === 125 && (extrinsic.args[0] as Bytes)?.at(0) === 123;
}