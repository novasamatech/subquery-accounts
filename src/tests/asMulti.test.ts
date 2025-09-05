import { subqlTest } from "@subql/testing";
import { AS_MULTI_CASES } from "./asMulti.cases";

/**
 * SubQuery mapping tests.
 *
 * Based on the SubQuery testing docs: https://subquery.network/doc/indexer/build/testing.html
 */

const filterBase = process.env["FILTER_MANIFEST_BASENAME"]
  ? String(process.env["FILTER_MANIFEST_BASENAME"])
  : "project-polkadot.yaml"; // Default to project-polkadot.yaml if not set

const testCase = AS_MULTI_CASES[filterBase];
if (!testCase) {
  throw new Error(
    `No test case found for manifest base: "${filterBase}". Please check FILTER_MANIFEST_BASENAME or your AS_MULTI_CASES config.`
  );
}


subqlTest(
  `${testCase.name} multisig.asMulti`,
  testCase.block,
  testCase.dependentEntities,
  testCase.expectedEntities,
  "handleNestedCalls"
);
