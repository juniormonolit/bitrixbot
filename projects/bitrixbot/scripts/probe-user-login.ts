/**
 * Проверка: отдаёт ли Bitrix REST поле LOGIN (user.fields + user.get).
 *
 * Примеры:
 *   npm run probe:user-login
 *   npm run probe:user-login -- --id 1 --login junior
 *   npx tsx --env-file=.env.local scripts/probe-user-login.ts --id 1 --login junior
 */

import { probeBitrixUserLoginField } from "../lib/bitrix/probe-user-login";

function argStr(name: string): string | null {
  const i = process.argv.indexOf(name);
  if (i < 0 || i + 1 >= process.argv.length) return null;
  const v = process.argv[i + 1]?.trim();
  return v || null;
}

async function main() {
  const bitrixUserId = argStr("--id") ?? argStr("--bitrixUserId");
  const login = argStr("--login");

  console.log("Probing Bitrix LOGIN field...");
  console.log({ bitrixUserId: bitrixUserId ?? "(none)", login: login ?? "(none)" });

  const probe = await probeBitrixUserLoginField({ bitrixUserId, loginFilter: login });

  console.log("\n--- user.fields ---");
  console.log("LOGIN in user.fields:", probe.userFieldsHasLogin, probe.userFieldsLoginLabel ?? "");
  console.log("Field count:", probe.userFieldKeys.length);

  console.log("\n--- probes ---");
  for (const p of probe.probes) {
    console.log(`\n[${p.label}]`);
    if (p.error) {
      console.log("  error:", p.error);
      continue;
    }
    console.log("  users:", p.usersReturned);
    console.log("  loginPresent:", p.loginPresent, "loginValue:", p.loginValue ?? "(null)");
    console.log("  sampleKeys:", p.sampleKeys.slice(0, 20).join(", "), p.sampleKeys.length > 20 ? "…" : "");
  }

  console.log("\n--- custom REST ---");
  console.log("method:", probe.customRestMethod);
  console.log("ok:", probe.customRestOk, "mapSize:", probe.customRestMapSize);
  if (probe.customRestLoginForUser) console.log("loginForUser:", probe.customRestLoginForUser);
  if (probe.customRestError) console.log("error:", probe.customRestError);
  console.log("next:", probe.recommendedNextStep);

  console.log("\n--- conclusion ---");
  console.log(probe.conclusion);

  const ok =
    probe.probes.some((p) => Boolean(p.loginValue)) ||
    Boolean(probe.customRestLoginForUser);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
