import { subqlTest } from "@subql/testing";
import { AS_MULTI_CASES } from "./asMulti.cases";

/**
 * SubQuery mapping tests.
 *
 * Based on the SubQuery testing docs: https://subquery.network/doc/indexer/build/testing.html
 */

const testCase = AS_MULTI_CASES[chainId.toString()];
if (!testCase) {
  throw new Error(
    `No test case found for chainId: "${chainId.toString()}".`
  );
}


subqlTest(
  `${testCase.name} multisig.asMulti`,
  testCase.block,
  testCase.dependentEntities,
  testCase.expectedEntities,
  "handleNestedCalls"
);
