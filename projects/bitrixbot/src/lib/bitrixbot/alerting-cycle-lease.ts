import { createServiceRoleClient } from "@/lib/supabase/server";

const MIN_LEASE = 30;
const MAX_LEASE = 3600;

/**
 * Try to take the single-flight lease for the alerting cron pipeline.
 * @returns true if this caller holds the lease until `releaseAlertingCycleLease` or TTL expiry.
 */
export async function tryAcquireAlertingCycleLease(leaseSeconds: number): Promise<boolean> {
  const sec = Math.min(MAX_LEASE, Math.max(MIN_LEASE, Math.floor(leaseSeconds || 900)));
  const supabase = createServiceRoleClient();
  const { data, error } = await supabase.rpc("try_acquire_alerting_cycle_lease", {
    p_lease_seconds: sec
  });
  if (error) {
    console.error("[alerting-cycle-lease] try_acquire failed", error.message);
    return false;
  }
  return Boolean(data);
}

export async function releaseAlertingCycleLease(): Promise<void> {
  const supabase = createServiceRoleClient();
  const { error } = await supabase.rpc("release_alerting_cycle_lease");
  if (error) console.error("[alerting-cycle-lease] release failed", error.message);
}
