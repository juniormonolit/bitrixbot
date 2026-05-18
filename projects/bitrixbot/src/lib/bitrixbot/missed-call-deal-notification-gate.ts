export type DealMappingNotificationBlockReason = "deal_mapping_disabled" | "deal_mapping_not_found";

export type DealMappingNotificationGateResult =
  | { block: false }
  | { block: true; reason: DealMappingNotificationBlockReason };

/**
 * Missed-call alerting requires a mapped deal_id from external mapping (activity id and/or phone fallback).
 * When mapping env is missing or no deal could be resolved, notifications must not be created.
 */
export function evaluateDealMappingNotificationGate(input: {
  mappingConfigured: boolean;
  resolvedDealId: number | null;
}): DealMappingNotificationGateResult {
  if (!input.mappingConfigured) {
    return { block: true, reason: "deal_mapping_disabled" };
  }
  if (input.resolvedDealId == null) {
    return { block: true, reason: "deal_mapping_not_found" };
  }
  return { block: false };
}
