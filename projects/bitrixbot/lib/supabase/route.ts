import { createServiceRoleClient } from "@/lib/supabase/server";

export function supabaseServiceRoleForRoute() {
  return createServiceRoleClient();
}

