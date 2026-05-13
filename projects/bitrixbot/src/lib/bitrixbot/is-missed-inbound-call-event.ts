import {
  evaluateMissedInboundCustomerCall,
  type CallEventForInboundFilter
} from "@/src/lib/bitrixbot/missed-inbound-customer-call";

type CallEventLike = CallEventForInboundFilter;

/** @deprecated Prefer {@link isMissedInboundCustomerCall} or {@link evaluateMissedInboundCustomerCall}. */
export function isMissedInboundCallEvent(callEvent: CallEventLike): boolean {
  return evaluateMissedInboundCustomerCall(callEvent).ok;
}

export { evaluateMissedInboundCustomerCall, isMissedInboundCustomerCall } from "@/src/lib/bitrixbot/missed-inbound-customer-call";
