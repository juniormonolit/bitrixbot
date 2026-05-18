/**
 * Asserts missed-call deal-mapping gate rules (no DB).
 * Run: npm run verify:deal-notification-guard
 */
import assert from "node:assert/strict";
import { evaluateDealMappingNotificationGate } from "../src/lib/bitrixbot/missed-call-deal-notification-gate";

assert.deepEqual(
  evaluateDealMappingNotificationGate({
    mappingConfigured: true,
    activityIdNum: 100,
    resolvedDealId: 555
  }),
  { block: false }
);

assert.deepEqual(
  evaluateDealMappingNotificationGate({
    mappingConfigured: false,
    activityIdNum: 100,
    resolvedDealId: null
  }),
  { block: true, reason: "deal_mapping_disabled" }
);

assert.deepEqual(
  evaluateDealMappingNotificationGate({
    mappingConfigured: true,
    activityIdNum: null,
    resolvedDealId: null
  }),
  { block: true, reason: "deal_mapping_not_found" }
);

assert.deepEqual(
  evaluateDealMappingNotificationGate({
    mappingConfigured: true,
    activityIdNum: 100,
    resolvedDealId: null
  }),
  { block: true, reason: "deal_mapping_not_found" }
);

console.log("verify-deal-notification-guard: ok");
