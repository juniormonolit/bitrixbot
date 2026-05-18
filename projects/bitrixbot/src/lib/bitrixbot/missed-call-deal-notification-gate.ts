export type DealMappingNotificationBlockReason = "deal_mapping_disabled" | "deal_mapping_not_found";

export type DealMappingNotificationGateResult =
  | { block: false }
  | { block: true; reason: DealMappingNotificationBlockReason };

/**
 * Missed-call alerting requires a mapped deal_id from external activity–deal mapping.
 * When mapping env is missing, or activity/deal cannot be resolved, notifications must not be created.
 */
export function evaluateDealMappingNotificationGate(input: {
  mappingConfigured: boolean;
  activityIdNum: number | null;
  resolvedDealId: number | null;
}): DealMappingNotificationGateResult {
  if (!input.mappingConfigured) {
    return { block: true, reason: "deal_mapping_disabled" };
  }
  if (input.activityIdNum == null) {
    return { block: true, reason: "deal_mapping_not_found" };
  }
  if (input.resolvedDealId == null) {
    return { block: true, reason: "deal_mapping_not_found" };
  }
  return { block: false };
}
