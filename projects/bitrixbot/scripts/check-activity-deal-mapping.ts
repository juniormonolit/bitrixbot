/**
 * Dev check for activity → deal mapping (external Supabase).
 *
 * Usage:
 *   npm run check:activity-mapping -- --activity 2251176
 *   npm run check:activity-mapping -- --phone 79669934409 --manager 8
 *   npm run check:activity-mapping -- --activity 2251176 --phone 79669934409 --manager 8
 *
 * Env:
 *   MAPPING_SUPABASE_URL, MAPPING_SUPABASE_SERVICE_ROLE_KEY,
 *   MAPPING_SUPABASE_SCHEMA (default public), MAPPING_SUPABASE_TABLE
 */

import {
  __resetActivityDealMappingModuleForDev,
  getActivityDealMappingConfig,
  getCrmActivityIdForDealMapping,
  isActivityDealMappingConfigured,
  parseBitrixActivityIdForMapping,
  resolveDealIdByActivityId,
  resolveDealMapping
} from "../src/lib/bitrixbot/activity-deal-mapping";

function argNum(name: string): number | null {
  const i = process.argv.indexOf(name);
  if (i === -1 || i + 1 >= process.argv.length) return null;
  const n = Number(process.argv[i + 1]);
  return Number.isFinite(n) ? n : null;
}

function argStr(name: string): string | null {
  const i = process.argv.indexOf(name);
  if (i === -1 || i + 1 >= process.argv.length) return null;
  const v = process.argv[i + 1]?.trim();
  return v ? v : null;
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
  const cfgPreview = getActivityDealMappingConfig();
  if (cfgPreview != null) {
    console.log("MAPPING resolved →", {
      schema: cfgPreview.schema,
      table: cfgPreview.table
    });
  }

  const act = argNum("--activity");
  const phoneRaw = argStr("--phone");
  const managerRaw = argStr("--manager");

  let activityIdNum: number | null = act;
  if (activityIdNum == null && phoneRaw == null && managerRaw == null && configured) {
    activityIdNum = 2251176;
    console.log("\n(default --activity 2251176 — pass flags to override)\n");
  }

  const crmStr =
    activityIdNum != null ? String(activityIdNum) : act != null ? String(act) : null;

  if (activityIdNum != null || phoneRaw != null || managerRaw != null) {
    console.log("\n--- resolveDealMapping ---", {
      activityIdNum,
      phone: phoneRaw ?? null,
      manager: managerRaw ?? null
    });
    if (configured) {
      const full = await resolveDealMapping({
        activityIdNum,
        crm_activity_id: crmStr,
        phone_normalized: phoneRaw,
        manager_bitrix_user_id: managerRaw
      });
      console.log("result deal_id:", full.dealId);
      console.log("source:", full.source ?? null);
      if (full.source === "phone") {
        console.log("matched row:", {
          bitrix_activity_id: full.matched_bitrix_activity_id ?? null,
          called_at: full.matched_called_at ?? null
        });
      }
    } else {
      console.log("(mapping env missing)");
    }
  } else if (!configured) {
    console.log("\n(mapping env missing — set MAPPING_SUPABASE_* to test live lookup)");
  }

  if (activityIdNum != null && configured && phoneRaw == null && managerRaw == null) {
    console.log("\n--- resolveDealIdByActivityId (activity-only legacy) ---");
    const dealOnly = await resolveDealIdByActivityId(activityIdNum, { crm_activity_id: crmStr });
    console.log("deal_id:", dealOnly);
  }

  console.log("\n--- env missing scenario (reset + no MAPPING_* ) ---");
  const savedUrl = process.env.MAPPING_SUPABASE_URL;
  const savedKey = process.env.MAPPING_SUPABASE_SERVICE_ROLE_KEY;
  const savedSchema = process.env.MAPPING_SUPABASE_SCHEMA;
  delete process.env.MAPPING_SUPABASE_URL;
  delete process.env.MAPPING_SUPABASE_SERVICE_ROLE_KEY;
  __resetActivityDealMappingModuleForDev();
  const missingDeal = await resolveDealIdByActivityId(1);
  console.log("resolve with env cleared ->", missingDeal, "(expect null)");
  process.env.MAPPING_SUPABASE_URL = savedUrl;
  process.env.MAPPING_SUPABASE_SERVICE_ROLE_KEY = savedKey;
  if (savedSchema !== undefined) process.env.MAPPING_SUPABASE_SCHEMA = savedSchema;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
