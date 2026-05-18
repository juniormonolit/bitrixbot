/**
 * Dev check for activity → deal mapping (external Supabase).
 *
 * Usage:
 *   npx tsx scripts/check-activity-deal-mapping.ts
 *   npx tsx scripts/check-activity-deal-mapping.ts --activity 12345
 *
 * Env (optional for live resolve test):
 *   MAPPING_SUPABASE_URL, MAPPING_SUPABASE_SERVICE_ROLE_KEY, MAPPING_SUPABASE_TABLE
 */

import {
  __resetActivityDealMappingModuleForDev,
  getCrmActivityIdForDealMapping,
  isActivityDealMappingConfigured,
  parseBitrixActivityIdForMapping,
  resolveDealIdByActivityId
} from "../src/lib/bitrixbot/activity-deal-mapping";

function argNum(name: string): number | null {
  const i = process.argv.indexOf(name);
  if (i === -1 || i + 1 >= process.argv.length) return null;
  const n = Number(process.argv[i + 1]);
  return Number.isFinite(n) ? n : null;
}

async function main() {
  console.log("--- parseBitrixActivityIdForMapping ---");
  console.log("null ->", parseBitrixActivityIdForMapping(null));
  console.log("'abc' ->", parseBitrixActivityIdForMapping("abc"));
  console.log("'42' ->", parseBitrixActivityIdForMapping("42"));

  console.log("\n--- getCrmActivityIdForDealMapping (payload fallback) ---");
  const samplePayload = {
    event: "ONVOXIMPLANTCALLEND",
    data: { CRM_ACTIVITY_ID: "999001", CALL_TYPE: "2" }
  };
  console.log(
    "column null + payload ->",
    getCrmActivityIdForDealMapping(null, samplePayload)
  );
  console.log(
    "column set ->",
    getCrmActivityIdForDealMapping("111", samplePayload)
  );
  console.log(
    "column as number (Supabase int) ->",
    getCrmActivityIdForDealMapping(2251176 as unknown, {})
  );
  console.log("parseBitrixActivityIdForMapping(2251176) ->", parseBitrixActivityIdForMapping(2251176));

  console.log("\n--- mapping env ---");
  __resetActivityDealMappingModuleForDev();
  const configured = isActivityDealMappingConfigured();
  console.log("isActivityDealMappingConfigured:", configured);

  let act = argNum("--activity");
  if (act == null && configured) {
    act = 2251176;
    console.log("\n--- live resolve default activity 2251176 (--activity <id> to override) ---");
  }
  if (act != null) {
    console.log(`\n--- resolveDealIdByActivityId(${act}) ---`);
    const deal = await resolveDealIdByActivityId(act, { crm_activity_id: String(act) });
    console.log("deal_id:", deal);
  } else {
    console.log("\n(mapping env missing — set MAPPING_SUPABASE_* to test live lookup)");
  }

  console.log("\n--- env missing scenario (reset + no MAPPING_* ) ---");
  /** Re-enables the one-shot warning after `__resetActivityDealMappingModuleForDev()`. */
  const savedUrl = process.env.MAPPING_SUPABASE_URL;
  const savedKey = process.env.MAPPING_SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.MAPPING_SUPABASE_URL;
  delete process.env.MAPPING_SUPABASE_SERVICE_ROLE_KEY;
  __resetActivityDealMappingModuleForDev();
  const missingDeal = await resolveDealIdByActivityId(1);
  console.log("resolve with env cleared ->", missingDeal, "(expect null)");
  process.env.MAPPING_SUPABASE_URL = savedUrl;
  process.env.MAPPING_SUPABASE_SERVICE_ROLE_KEY = savedKey;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
