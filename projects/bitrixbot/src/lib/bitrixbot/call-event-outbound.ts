type JsonObject = Record<string, unknown>;

function getObj(value: unknown): JsonObject {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as JsonObject;
  return {};
}

function getString(value: unknown): string | null {
  if (typeof value === "string") {
    const v = value.trim();
    return v ? v : null;
  }
  if (typeof value === "number") return String(value);
  return null;
}

function getNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const v = value.trim();
    if (!v) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Minimal shape for outbound detection (call_events row or ingest snapshot). */
export type CallEventOutboundLike = {
  call_direction?: string | null;
  call_type_raw?: string | null;
  raw_payload?: unknown;
};

/**
 * Outbound if ANY reliable signal says so (column ingest from normalizeBitrixCallEvent OR payload).
 * Conservative: avoids false missed-customer alerts when manager initiated the call.
 */
export function callEventHasOutboundSignals(event: CallEventOutboundLike): boolean {
  if (event.call_direction === "outbound") return true;
  const col = event.call_type_raw?.trim();
  if (col === "1") return true;

  const root = getObj(event.raw_payload);
  const data = getObj(root.data ?? root.DATA);

  const ctStr = getString(data.CALL_TYPE);
  if (ctStr === "1") return true;
  const ctNum = getNumber(data.CALL_TYPE);
  if (ctNum === 1) return true;

  const dir =
    getString(data.CALL_DIRECTION) ??
    getString(data.call_direction);
  const dirU = dir?.toUpperCase() ?? "";
  if (dirU === "OUTGOING" || dirU === "OUTBOUND") return true;

  const rootCt = getString(root.CALL_TYPE);
  if (rootCt === "1") return true;

  return false;
}

/**
 * CALL_TYPE string from payload (incl. numeric), then root fallback, then DB column `call_type_raw`.
 */
export function resolveCallTypeDigits(event: CallEventOutboundLike): string {
  const root = getObj(event.raw_payload);
  const data = getObj(root.data ?? root.DATA);
  const fromPayloadStr = getString(data.CALL_TYPE);
  if (fromPayloadStr) return fromPayloadStr;
  const fromPayloadNum = getNumber(data.CALL_TYPE);
  if (fromPayloadNum === 1) return "1";
  if (fromPayloadNum === 2) return "2";
  if (fromPayloadNum === 3) return "3";
  const rootStr = getString(root.CALL_TYPE);
  if (rootStr) return rootStr;
  return event.call_type_raw?.trim() ?? "";
}
