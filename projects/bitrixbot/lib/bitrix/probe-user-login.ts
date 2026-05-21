import { bitrixCall } from "@/lib/bitrix/client";
import { runWithBitrixRestContext } from "@/lib/bitrix/bitrix-rest-context";
import {
  DEFAULT_MANAGERS_LIST_METHOD,
  getManagersListForSync,
  getManagersListRestMethod
} from "@/lib/bitrix/managers-list-sync";

type JsonUser = Record<string, unknown>;

export type UserLoginProbeCase = {
  label: string;
  params: Record<string, unknown>;
  error: string | null;
  usersReturned: number;
  loginPresent: boolean;
  loginValue: string | null;
  /** Keys returned on first user (for debugging scope/select). */
  sampleKeys: string[];
  sampleUser: JsonUser | null;
};

export type ProbeBitrixUserLoginResult = {
  /** Whether `user.fields` lists a LOGIN key. */
  userFieldsHasLogin: boolean;
  userFieldsLoginLabel: string | null;
  /** All field keys from user.fields (sorted). */
  userFieldKeys: string[];
  probes: UserLoginProbeCase[];
  /** When LOGIN is unavailable — fields that did return for a targeted user.get by ID. */
  /** Custom on-premise REST (bitrixbot.user.logins.list). */
  customRestMethod: string | null;
  customRestOk: boolean;
  customRestError: string | null;
  customRestLoginForUser: string | null;
  customRestMapSize: number;
  recommendedNextStep: string;
  conclusion: string;
};

function asUserList(result: unknown): JsonUser[] {
  if (!Array.isArray(result)) return [];
  return result.filter((u) => u && typeof u === "object") as JsonUser[];
}

function pickLogin(u: JsonUser | null): { present: boolean; value: string | null } {
  if (!u) return { present: false, value: null };
  if (!("LOGIN" in u)) return { present: false, value: null };
  const raw = u.LOGIN;
  if (raw === null || raw === undefined) return { present: true, value: null };
  const v = String(raw).trim();
  return { present: true, value: v || null };
}

async function runProbeGet(
  label: string,
  params: Record<string, unknown>
): Promise<UserLoginProbeCase> {
  try {
    const result = await bitrixCall<unknown>("user.get", params);
    const users = asUserList(result);
    const sample = users[0] ?? null;
    const { present, value } = pickLogin(sample);
    return {
      label,
      params,
      error: null,
      usersReturned: users.length,
      loginPresent: present,
      loginValue: value,
      sampleKeys: sample ? Object.keys(sample).sort() : [],
      sampleUser: sample
    };
  } catch (e) {
    return {
      label,
      params,
      error: e instanceof Error ? e.message : String(e),
      usersReturned: 0,
      loginPresent: false,
      loginValue: null,
      sampleKeys: [],
      sampleUser: null
    };
  }
}

async function runProbeCurrent(
  label: string,
  params: Record<string, unknown>
): Promise<UserLoginProbeCase> {
  try {
    const result = await bitrixCall<unknown>("user.current", params);
    const users = Array.isArray(result) ? asUserList(result) : [result as JsonUser];
    const sample = users[0] ?? null;
    const { present, value } = pickLogin(sample);
    return {
      label,
      params,
      error: null,
      usersReturned: users.length,
      loginPresent: present,
      loginValue: value,
      sampleKeys: sample ? Object.keys(sample).sort() : [],
      sampleUser: sample
    };
  } catch (e) {
    return {
      label,
      params,
      error: e instanceof Error ? e.message : String(e),
      usersReturned: 0,
      loginPresent: false,
      loginValue: null,
      sampleKeys: [],
      sampleUser: null
    };
  }
}

/**
 * Checks whether this Bitrix portal exposes `LOGIN` via REST (`user.fields` + `user.get`).
 */
export async function probeBitrixUserLoginField(input: {
  bitrixUserId?: string | null;
  loginFilter?: string | null;
}): Promise<ProbeBitrixUserLoginResult> {
  return runWithBitrixRestContext("daily_company_structure_sync", async () => {
    const bitrixUserId = input.bitrixUserId?.trim() || null;
    const loginFilter = input.loginFilter?.trim() || null;

    const fieldsRaw = await bitrixCall<Record<string, string>>("user.fields", {});
    const userFieldKeys = Object.keys(fieldsRaw ?? {}).sort();
    const userFieldsHasLogin = userFieldKeys.includes("LOGIN");
    const userFieldsLoginLabel = userFieldsHasLogin ? (fieldsRaw.LOGIN ?? null) : null;

    const probes: UserLoginProbeCase[] = [];

    probes.push(
      await runProbeCurrent("user.current (no select)", {}),
      await runProbeCurrent("user.current + select LOGIN", {
        select: ["ID", "LOGIN", "EMAIL", "NAME", "LAST_NAME"]
      })
    );

    if (bitrixUserId) {
      probes.push(
        await runProbeGet(`user.get ID=${bitrixUserId} + select LOGIN`, {
          filter: { ID: bitrixUserId },
          select: ["ID", "LOGIN", "EMAIL", "XML_ID", "NAME", "LAST_NAME", "UF_DEPARTMENT"]
        }),
        await runProbeGet(`user.get ID=${bitrixUserId} + ADMIN_MODE + select LOGIN`, {
          filter: { ID: bitrixUserId },
          select: ["ID", "LOGIN", "EMAIL", "XML_ID", "NAME", "LAST_NAME"],
          ADMIN_MODE: true
        }),
        await runProbeGet(`user.get ID=${bitrixUserId} (no select, ADMIN_MODE)`, {
          filter: { ID: bitrixUserId },
          ADMIN_MODE: true
        })
      );
    }

    if (loginFilter) {
      probes.push(
        await runProbeGet(`user.get filter LOGIN=${loginFilter}`, {
          filter: { LOGIN: loginFilter },
          select: ["ID", "LOGIN", "EMAIL", "NAME", "LAST_NAME"]
        }),
        await runProbeGet(`user.get filter LOGIN=${loginFilter} + ADMIN_MODE`, {
          filter: { LOGIN: loginFilter },
          select: ["ID", "LOGIN", "EMAIL", "NAME", "LAST_NAME"],
          ADMIN_MODE: true
        })
      );
    }

    const customRestMethod = getManagersListRestMethod() ?? DEFAULT_MANAGERS_LIST_METHOD;
    let customRestOk = false;
    let customRestError: string | null = null;
    let customRestLoginForUser: string | null = null;
    let customRestMapSize = 0;
    let managersListSource: "cache" | "bitrix" | null = null;

    try {
      const managers = await getManagersListForSync({ force: true });
      managersListSource = managers.source;
      customRestMapSize = managers.rowCount;
      customRestOk = managers.rowCount > 0;
      if (bitrixUserId) {
        const hit = managers.users.find((u) => u.ID === bitrixUserId);
        customRestLoginForUser = hit?.LOGIN ?? null;
      }
      if (!customRestOk) {
        customRestError = "method_responded_but_no_rows";
      }
    } catch (e) {
      customRestError = e instanceof Error ? e.message : String(e);
    }

    const loginFilterIgnored =
      Boolean(loginFilter) &&
      probes.some(
        (p) =>
          p.label.includes("filter LOGIN=") &&
          !p.error &&
          p.usersReturned >= 50 &&
          !p.loginPresent
      );

    const anyLoginValue = probes.some((p) => p.loginValue);
    const anyLoginKey = probes.some((p) => p.loginPresent);
    let conclusion: string;
    if (anyLoginValue) {
      conclusion =
        "LOGIN доступен через REST: в ответе user.get есть непустое поле LOGIN. Можно добавить LOGIN в sync employees.";
    } else if (anyLoginKey) {
      conclusion =
        "Ключ LOGIN есть в ответе, но значение пустое — проверьте bitrixUserId/login или права webhook.";
    } else if (userFieldsHasLogin) {
      conclusion =
        "user.fields объявляет LOGIN, но user.get не вернул поле — проверьте select/scope (нужен scope user).";
    } else if (customRestOk && customRestLoginForUser) {
      conclusion = `user.get без LOGIN; ${customRestMethod} работает (login=${customRestLoginForUser}, source=${managersListSource}).`;
    } else if (customRestOk) {
      conclusion = `Кастомный ${customRestMethod} отвечает (${customRestMapSize} логинов), но для bitrixUserId=${bitrixUserId ?? "?"} login не найден.`;
    } else {
      const filterNote = loginFilterIgnored
        ? " Фильтр filter[LOGIN] игнорируется (вернулось 50 пользователей)."
        : "";
      conclusion =
        `Стандартный REST не отдаёт LOGIN.${filterNote} Проверьте MANAGER_BITRIX_REST_BASE_URL и BITRIX_USER_LOGINS_REST_METHOD=${customRestMethod}.`;
    }

    let recommendedNextStep: string;
    if (anyLoginValue || (customRestOk && customRestLoginForUser)) {
      recommendedNextStep =
        "Задайте BITRIX_USER_LOGINS_REST_METHOD (если ещё не задано), примените миграцию employees.bitrix_login, запустите sync.";
    } else if (customRestError?.includes("ERROR_METHOD_NOT_FOUND") || customRestError?.includes("METHOD_NOT_FOUND")) {
      recommendedNextStep =
        "На портале Bitrix установите BitrixbotUserLoginRest.php и scope bitrixbot для вебхука (см. docs/bitrix-login-custom-rest.md).";
    } else {
      recommendedNextStep =
        "Скопируйте bitrix-portal/rest/BitrixbotUserLoginRest.php на сервер портала, зарегистрируйте OnRestServiceBuildDescription, проверьте снова probe.";
    }

    return {
      userFieldsHasLogin,
      userFieldsLoginLabel,
      userFieldKeys,
      probes,
      customRestMethod,
      customRestOk,
      customRestError,
      customRestLoginForUser,
      customRestMapSize,
      recommendedNextStep,
      conclusion
    };
  });
}
