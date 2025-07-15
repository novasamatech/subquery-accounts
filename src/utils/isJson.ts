import { Bytes } from "@polkadot/types";

export const isJsonStringArgs = (args: Bytes[]) => {
  //123 is {  and  125 is }        :)
  return (args[0] as Bytes).at(-1) === 125 && (args[0] as Bytes).at(0) === 123;
}