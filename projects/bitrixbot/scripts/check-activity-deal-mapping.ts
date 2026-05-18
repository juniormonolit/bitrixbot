/**
 * Проверка activity → deal mapping (внешний Supabase).
 *
 * Примеры:
 *   npm run check:activity-mapping -- --activity 2251176
 *   npm run check:activity-mapping -- --phone 79669934409 --manager 8
 *   npm run check:activity-mapping -- --activity 2251176 --phone 79669934409 --manager 8
 *
 * Env:
 *   MAPPING_SUPABASE_URL, MAPPING_SUPABASE_SERVICE_ROLE_KEY,
 *   MAPPING_SUPABASE_SCHEMA (default public), MAPPING_SUPABASE_TABLE,
 *   MAPPING_PHONE_FALLBACK_DAYS (default 90; невалидное значение → 90)
 *
 * На сервере (production secrets):
 *   npx tsx --env-file=.env.production scripts/check-activity-deal-mapping.ts --activity … --phone … --manager …
 */

import {
  __resetActivityDealMappingModuleForDev,
  getActivityDealMappingConfig,
  getCrmActivityIdForDealMapping,
  isActivityDealMappingConfigured,
  parseBitrixActivityIdForMapping,
  parseMappingPhoneFallbackDays,
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

function printReport(title: string, full: Awaited<ReturnType<typeof resolveDealMapping>>) {
  console.log(`\n=== ${title} ===`);
  console.log("deal_id:", full.dealId);
  console.log("source:", full.source);
  console.log("confidence:", full.confidence);
  console.log("matched_row:", full.matched_row);
  console.log("fallback_days:", full.fallback_days);
  console.log("called_at_from:", full.called_at_from);
  console.log("query_errors:", full.queryErrors.length ? full.queryErrors : "(none)");
  if (full.multiple_deals_by_phone) {
    console.log("note: multiple distinct deal_id on phone → confidence 0.3, freshest called_at chosen");
  }
}

async function main() {
  const verbose = process.argv.includes("--verbose");

  if (verbose) {
    console.log("--- parseBitrixActivityIdForMapping ---");
    console.log("null ->", parseBitrixActivityIdForMapping(null));
    console.log("'abc' ->", parseBitrixActivityIdForMapping("abc"));
    console.log("'42' ->", parseBitrixActivityIdForMapping("42"));

    console.log("\n--- getCrmActivityIdForDealMapping (payload fallback) ---");
    const samplePayload = {
      event: "ONVOXIMPLANTCALLEND",
      data: { CRM_ACTIVITY_ID: "999001", CALL_TYPE: "2" }
    };
    console.log("column null + payload ->", getCrmActivityIdForDealMapping(null, samplePayload));
    console.log("column set ->", getCrmActivityIdForDealMapping("111", samplePayload));
    console.log(
      "column as number (Supabase int) ->",
      getCrmActivityIdForDealMapping(2251176 as unknown, {})
    );
    console.log("parseBitrixActivityIdForMapping(2251176) ->", parseBitrixActivityIdForMapping(2251176));
  }

  console.log("\nMAPPING_PHONE_FALLBACK_DAYS (effective):", parseMappingPhoneFallbackDays());
  console.log(
    "На сервере загрузите секреты, например:\n" +
      "  npx tsx --env-file=.env.production scripts/check-activity-deal-mapping.ts --activity … --phone … --manager …\n"
  );

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
    console.log("\n(default --activity 2251176 — переопределите флагами)\n");
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
      printReport("Результат", full);
    } else {
      console.log("(MAPPING_SUPABASE_* не заданы — live lookup недоступен)");
    }
  } else if (!configured) {
    console.log("\n(задайте MAPPING_SUPABASE_* для live lookup)");
  }

  if (activityIdNum != null && configured && phoneRaw == null && managerRaw == null) {
    console.log("\n--- resolveDealIdByActivityId (legacy, activity-only) ---");
    const dealOnly = await resolveDealIdByActivityId(activityIdNum, { crm_activity_id: crmStr });
    console.log("deal_id:", dealOnly);
  }

  if (verbose) {
    console.log("\n--- env missing scenario (reset + no MAPPING_* ) ---");
    const savedUrl = process.env.MAPPING_SUPABASE_URL;
    const savedKey = process.env.MAPPING_SUPABASE_SERVICE_ROLE_KEY;
    const savedSchema = process.env.MAPPING_SUPABASE_SCHEMA;
    const savedFallback = process.env.MAPPING_PHONE_FALLBACK_DAYS;
    delete process.env.MAPPING_SUPABASE_URL;
    delete process.env.MAPPING_SUPABASE_SERVICE_ROLE_KEY;
    __resetActivityDealMappingModuleForDev();
    const missingDeal = await resolveDealIdByActivityId(1);
    console.log("resolve with env cleared ->", missingDeal, "(expect null)");
    process.env.MAPPING_SUPABASE_URL = savedUrl;
    process.env.MAPPING_SUPABASE_SERVICE_ROLE_KEY = savedKey;
    if (savedSchema !== undefined) process.env.MAPPING_SUPABASE_SCHEMA = savedSchema;
    if (savedFallback !== undefined) process.env.MAPPING_PHONE_FALLBACK_DAYS = savedFallback;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
