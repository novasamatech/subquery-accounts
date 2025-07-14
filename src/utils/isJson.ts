import { Bytes } from "@polkadot/types";
import { Extrinsic } from "@polkadot/types/interfaces";

export const isJsonStringArgs = (extrinsic: Extrinsic) => {
  const bytesArg = extrinsic.args[0] as Bytes;
  if (!bytesArg || !(typeof bytesArg.at === 'function')) {
    return false;
  }

  //123 is {  and  125 is }        :)
  return bytesArg.at(-1) === 125 && bytesArg.at(0) === 123;
}