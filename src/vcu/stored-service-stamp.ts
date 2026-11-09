import type { AuditRecord } from "./write-audit.ts";
import { EARLIEST_CREDIBLE_SERVICE_MS } from "./service-actions.ts";

/** Journal order is append order, even when the Pi has stepped its wall clock. */
export function storedServiceStamp(records: AuditRecord[], nowMs: number): StoredServiceStamp | null {
  for (const record of records) {
    if (record.action === "read-service-stamp" && record.status === "read") {
      return recordedStamp(
        record.before,
        record.at,
        record.note === "read cleanly" ? null : (record.note ?? null),
        nowMs
      );
    }
    if (record.action === "set-service-point" && record.status !== "refused") {
      if (record.status === "started" && typeof record.after === "string") {
        return recordedStamp(record.after, record.at, record.note?.includes("⚠") ? record.note : null, nowMs);
      }
      return { readAt: record.at, dateIso: null, implausible: null, confirmed: false };
    }
  }
  return null;
}

export interface StoredServiceStamp {
  readAt: number;
  dateIso: string | null;
  implausible: string | null;
  /** A later service-point attempt without a readback invalidates the previous date. */
  confirmed: boolean;
}

function recordedStamp(
  value: AuditRecord["before"],
  readAt: number,
  implausible: string | null,
  nowMs: number
): StoredServiceStamp {
  const dateIso = typeof value === "string" ? value : null;
  const timestamp = dateIso === null ? NaN : Date.parse(dateIso);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== dateIso) {
    implausible = "The stored service date is invalid.";
  } else if (timestamp < EARLIEST_CREDIBLE_SERVICE_MS || timestamp > nowMs) {
    implausible ??= "The stored service date is outside the credible range.";
  }
  return { readAt, dateIso, implausible, confirmed: true };
}
