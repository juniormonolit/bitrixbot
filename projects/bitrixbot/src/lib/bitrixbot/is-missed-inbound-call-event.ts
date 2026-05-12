type CallEventLike = {
  status?: string | null;
  call_direction?: string | null;
};

export function isMissedInboundCallEvent(callEvent: CallEventLike): boolean {
  return callEvent.call_direction === "inbound" && callEvent.status === "missed";
}

