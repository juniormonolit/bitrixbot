import {
  evaluateMissedInboundCustomerCall,
  type CallEventForInboundFilter
} from "@/lib/bitrixbot/missed-inbound-customer-call";

type CallEventLike = CallEventForInboundFilter;

/** @deprecated Prefer {@link isMissedInboundCustomerCall} or {@link evaluateMissedInboundCustomerCall}. */
export function isMissedInboundCallEvent(callEvent: CallEventLike): boolean {
  return evaluateMissedInboundCustomerCall(callEvent).ok;
}

export {
  evaluateMissedInboundCustomerCall,
  filterSkipReasonLabel,
  isActuallyMissedInboundCallEvent,
  isMissedInboundCustomerCall
} from "@/lib/bitrixbot/missed-inbound-customer-call";
export { callEventHasOutboundSignals, resolveCallTypeDigits } from "@/lib/bitrixbot/call-event-outbound";
