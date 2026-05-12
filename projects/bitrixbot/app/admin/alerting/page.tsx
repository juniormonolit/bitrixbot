import { env } from "@/lib/env";
import { revalidatePath } from "next/cache";
import { getAlertingSettings } from "@/src/lib/bitrixbot/get-alerting-settings";
import { updateAlertingSettings } from "@/src/lib/bitrixbot/update-alerting-settings";
import { getAlertingDashboardSummary } from "@/src/lib/bitrixbot/alerting-dashboard";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { ManualActions } from "./manual-actions";

type CaseRow = {
  id: string;
  status: string;
  phone_normalized: string;
  manager_name: string | null;
  deal_id: number | null;
  missed_count: number;
  last_missed_at: string;
  last_outbound_at: string | null;
  last_successful_callback_at: string | null;
  last_triggered_at: string | null;
  created_at: string;
};

type DeliveryRow = {
  id: string;
  created_at: string;
  case_id: string;
  recipient_role: string;
  recipient_name: string | null;
  delivery_status: string;
  message_text: string;
  provider_name: string;
  sent_at: string | null;
  error_message: string | null;
};

type MirrorDeliveryRow = {
  id: string;
  created_at: string;
  delivery_id: string;
  mirror_bitrix_user_id: string;
  delivery_status: string;
  sent_at: string | null;
  error_message: string | null;
  message_text: string;
};

function isAuthorized(searchParams: Record<string, string | string[] | undefined>): boolean {
  const secret = typeof searchParams.secret === "string" ? searchParams.secret : "";
  return Boolean(secret) && secret === env.DEBUG_SECRET;
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-white/10 bg-white/5 p-5">
      <div className="mb-3 text-sm font-medium text-white/80">{title}</div>
      {children}
    </section>
  );
}

function Badge({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      className={[
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
        ok ? "bg-emerald-500/15 text-emerald-200" : "bg-rose-500/15 text-rose-200"
      ].join(" ")}
    >
      {label}
    </span>
  );
}

function DeliveryStatusCell({ status }: { status: string }) {
  const s = String(status ?? "");
  if (s === "skipped") {
    return (
      <span
        className="inline-flex max-w-[14rem] cursor-help flex-col gap-0.5"
        title="Не отправлено основному адресату из-за mirror-only режима"
      >
        <span className="inline-flex w-fit rounded-full bg-amber-500/20 px-2 py-0.5 font-medium text-amber-100">
          skipped
        </span>
        <span className="text-[10px] leading-tight text-amber-200/80">
          Не отправлено основному адресату (mirror-only)
        </span>
      </span>
    );
  }
  if (s === "sent") {
    return <span className="text-emerald-200/90">{s}</span>;
  }
  if (s === "failed") {
    return <span className="text-rose-200/90">{s}</span>;
  }
  return <span>{s}</span>;
}

async function fetchLastCases() {
  const supabase = createServiceRoleClient();
  const { data, error } = await supabase
    .from("missed_call_cases")
    .select(
      "id, status, phone_normalized, manager_name, deal_id, missed_count, last_missed_at, last_outbound_at, last_successful_callback_at, last_triggered_at, created_at"
    )
    .order("last_missed_at", { ascending: false })
    .limit(20);
  if (error) throw new Error(error.message);
  return (data ?? []) as CaseRow[];
}

async function fetchLastDeliveries() {
  const supabase = createServiceRoleClient();
  const { data, error } = await supabase
    .from("notification_deliveries")
    .select(
      "id, created_at, case_id, recipient_role, recipient_name, delivery_status, message_text, provider_name, sent_at, error_message"
    )
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) throw new Error(error.message);
  return (data ?? []) as DeliveryRow[];
}

async function fetchLastMirrorDeliveries() {
  const supabase = createServiceRoleClient();
  const { data, error } = await supabase
    .from("notification_delivery_mirrors")
    .select(
      "id, created_at, delivery_id, mirror_bitrix_user_id, delivery_status, sent_at, error_message, message_text"
    )
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) throw new Error(error.message);
  return (data ?? []) as MirrorDeliveryRow[];
}

export default async function AlertingConsolePage({
  searchParams
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;

  if (!isAuthorized(sp)) {
    return (
      <main className="mx-auto flex min-h-screen max-w-lg flex-col justify-center px-6 py-16">
        <div className="rounded-2xl border border-white/10 bg-white/5 p-8 text-center shadow-lg">
          <h1 className="text-xl font-semibold text-white">Доступ запрещён</h1>
          <p className="mt-4 text-sm leading-relaxed text-white/70">
            Откройте консоль с корректным secret-параметром в адресной строке.
          </p>
          <p className="mt-3 text-xs text-white/45">
            Пример: <code className="rounded bg-black/30 px-1.5 py-0.5 text-white/75">/admin/alerting?secret=…</code>
          </p>
        </div>
      </main>
    );
  }

  const [settings, summary, cases, deliveries, mirrorDeliveries] = await Promise.all([
    getAlertingSettings(),
    getAlertingDashboardSummary(),
    fetchLastCases(),
    fetchLastDeliveries(),
    fetchLastMirrorDeliveries()
  ]);

  async function saveSettings(formData: FormData) {
    "use server";
    const getStr = (key: string) => {
      const v = formData.get(key);
      return typeof v === "string" ? v : "";
    };
    await updateAlertingSettings({
      sending_enabled: formData.has("sending_enabled"),
      dry_run_mode: formData.has("dry_run_mode"),
      send_only_to_mirror: formData.has("send_only_to_mirror"),
      mirror_enabled: formData.has("mirror_enabled"),
      mirror_bitrix_user_id: getStr("mirror_bitrix_user_id").trim() || null,
      updated_reason: getStr("updated_reason").trim() || null
    });
    revalidatePath("/admin/alerting");
  }

  async function stopAll() {
    "use server";
    await updateAlertingSettings({
      sending_enabled: false,
      dry_run_mode: true,
      updated_reason: "СТОП ВСЕ ОТПРАВКИ"
    });
    revalidatePath("/admin/alerting");
  }

  async function applyMirrorOnlyTestPreset() {
    "use server";
    await updateAlertingSettings({
      sending_enabled: true,
      dry_run_mode: false,
      send_only_to_mirror: true,
      mirror_enabled: true,
      mirror_bitrix_user_id: "2089",
      updated_reason: "Консоль: тестовый режим mirror-only (preset)"
    });
    revalidatePath("/admin/alerting");
  }

  const isLive = settings.sending_enabled && !settings.dry_run_mode;
  const mirrorOnly = settings.send_only_to_mirror && isLive;

  return (
    <main className="mx-auto flex min-h-screen max-w-6xl flex-col gap-6 px-6 py-10">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold">Консоль alerting</h1>
        <div className="flex flex-wrap items-center gap-2">
          <Badge ok={settings.sending_enabled} label={`Отправка: ${settings.sending_enabled ? "ВКЛ" : "ВЫКЛ"}`} />
          <Badge ok={settings.dry_run_mode} label={`Dry run: ${settings.dry_run_mode ? "ВКЛ" : "ВЫКЛ"}`} />
          <Badge ok={settings.mirror_enabled} label={`Дублирование: ${settings.mirror_enabled ? "ВКЛ" : "ВЫКЛ"}`} />
          <span className="text-xs text-white/60">
            Mirror user id: <span className="text-white/80">{settings.mirror_bitrix_user_id ?? "—"}</span>
          </span>
        </div>
      </header>

      {mirrorOnly ? (
        <div className="rounded-xl border-2 border-amber-400/45 bg-amber-500/20 px-4 py-3 text-center text-sm font-semibold leading-snug text-amber-50">
          ТЕСТОВЫЙ РЕЖИМ: сообщения уходят только mirror-пользователю, основным получателям не отправляются.
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
        <Card title="Боевой режим">
          <div className="flex items-center justify-between">
            <div className="text-sm text-white/70">Live sending</div>
            <Badge ok={isLive} label={isLive ? "ДА" : "НЕТ"} />
          </div>
          {mirrorOnly ? (
            <div className="mt-2 text-xs text-white/60">Тест: отправка только в дубль</div>
          ) : null}
        </Card>
        <Card title="Open cases">
          <div className="text-2xl font-semibold">{summary.openCases}</div>
        </Card>
        <Card title="Pending deliveries">
          <div className="text-2xl font-semibold">{summary.pendingDeliveries}</div>
        </Card>
        <Card title="Failed processing">
          <div className="text-2xl font-semibold">{summary.failedCallEventProcessing}</div>
        </Card>
      </div>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
        <Card title="Sent (24h)">
          <div className="text-2xl font-semibold">{summary.sentDeliveries24h}</div>
        </Card>
        <Card title="Failed deliveries">
          <div className="text-2xl font-semibold">{summary.failedDeliveries}</div>
        </Card>
        <Card title="Skipped primary deliveries">
          <div className="text-2xl font-semibold">{summary.skippedPrimaryDeliveries}</div>
          <div className="mt-1 text-[11px] text-white/50">delivery_status = skipped</div>
        </Card>
        <Card title="Pending mirrors">
          <div className="text-2xl font-semibold">{summary.pendingMirrors}</div>
        </Card>
        <Card title="Failed mirrors">
          <div className="text-2xl font-semibold">{summary.failedMirrors}</div>
        </Card>
        <Card title="Open SLA">
          <div className="text-2xl font-semibold">{summary.openSlaExecutions}</div>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card title="Тестовый режим одной кнопкой">
          <p className="mb-3 text-xs leading-relaxed text-white/65">
            Установит в БД: <code className="text-white/85">sending_enabled=true</code>,{" "}
            <code className="text-white/85">dry_run_mode=false</code>,{" "}
            <code className="text-white/85">send_only_to_mirror=true</code>,{" "}
            <code className="text-white/85">mirror_enabled=true</code>,{" "}
            <code className="text-white/85">mirror_bitrix_user_id=2089</code>.
          </p>
          <form action={applyMirrorOnlyTestPreset}>
            <button
              type="submit"
              className="rounded-md bg-amber-500/25 px-4 py-2 text-sm font-medium text-amber-50 ring-1 ring-amber-400/40 hover:bg-amber-500/35"
            >
              Включить тестовый пресет (mirror-only, user 2089)
            </button>
          </form>
        </Card>

        <Card title="Как тестировать">
          <ol className="list-decimal space-y-2 pl-5 text-sm leading-relaxed text-white/75">
            <li>Включите sending_enabled (разрешить реальную отправку).</li>
            <li>Выключите dry_run_mode (снять безопасный режим).</li>
            <li>Включите send_only_to_mirror (только дубль основным адресатам не уходит).</li>
            <li>Проверьте mirror_bitrix_user_id (в пресете — 2089, при необходимости поправьте и сохраните).</li>
            <li>
              В блоке «Ручные действия» выберите <strong>Запустить полный цикл</strong> и выполните.
            </li>
            <li>
              Проверьте: primary deliveries со статусом <code className="text-white/85">skipped</code>, mirror
              deliveries — <code className="text-white/85">sent</code>, сообщения пришли mirror-пользователю.
            </li>
          </ol>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Card title="Красная кнопка / настройки отправки">
          <form action={saveSettings} className="space-y-4">
            <label className="flex items-center gap-3">
              <input
                name="sending_enabled"
                type="checkbox"
                defaultChecked={settings.sending_enabled}
              />
              <span className="text-sm">Разрешить реальную отправку сообщений</span>
            </label>

            <label className="flex items-center gap-3">
              <input name="dry_run_mode" type="checkbox" defaultChecked={settings.dry_run_mode} />
              <span className="text-sm">Безопасный режим (dry run)</span>
            </label>

            <label className="flex items-center gap-3">
              <input
                name="send_only_to_mirror"
                type="checkbox"
                defaultChecked={settings.send_only_to_mirror}
              />
              <span className="text-sm">Тест: отправлять только в дубль (без основных получателей)</span>
            </label>

            <div className="space-y-2">
              <div className="text-sm text-white/70">Причина изменения</div>
              <input
                name="updated_reason"
                className="w-full rounded-md border border-white/10 bg-black/20 px-3 py-2 text-sm"
                placeholder="опционально"
                defaultValue={settings.updated_reason ?? ""}
              />
            </div>

            <div className="flex flex-wrap gap-3">
              <button
                type="submit"
                className="rounded-md bg-white/10 px-4 py-2 text-sm hover:bg-white/15"
              >
                Сохранить
              </button>
              <button
                formAction={stopAll}
                className="rounded-md bg-rose-600 px-4 py-2 text-sm font-medium text-white hover:bg-rose-500"
              >
                СТОП ВСЕ ОТПРАВКИ
              </button>
            </div>

            {isLive ? (
              <div className="rounded-md border border-rose-500/40 bg-rose-500/10 p-3 text-sm text-rose-200">
                Система находится в боевом режиме. Реальные сообщения могут быть отправлены.
              </div>
            ) : null}

            {mirrorOnly ? (
              <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-100">
                ТЕСТОВЫЙ РЕЖИМ: сообщения уходят только mirror-пользователю, основным получателям не отправляются.
              </div>
            ) : null}
          </form>
        </Card>

        <Card title="Дублировать все сообщения мне">
          <form action={saveSettings} className="space-y-4">
            <label className="flex items-center gap-3">
              <input name="mirror_enabled" type="checkbox" defaultChecked={settings.mirror_enabled} />
              <span className="text-sm">Дублировать все сообщения мне</span>
            </label>
            <div className="space-y-2">
              <div className="text-sm text-white/70">Bitrix user id для дублей</div>
              <input
                name="mirror_bitrix_user_id"
                className="w-full rounded-md border border-white/10 bg-black/20 px-3 py-2 text-sm"
                defaultValue={settings.mirror_bitrix_user_id ?? ""}
              />
            </div>
            <button
              type="submit"
              className="rounded-md bg-white/10 px-4 py-2 text-sm hover:bg-white/15"
            >
              Сохранить
            </button>
          </form>
        </Card>
      </div>

      <Card title="Ручные действия">
        <div className="mb-3 rounded-md border border-white/10 bg-black/20 p-3 text-xs text-white/70">
          {settings.sending_enabled ? (
            settings.dry_run_mode ? (
              <span>Сейчас safe mode / dry run: реальная отправка заблокирована.</span>
            ) : settings.send_only_to_mirror ? (
              <span>ТЕСТ LIVE: отправка только дублей (основные получатели не получат сообщения).</span>
            ) : (
              <span className="text-rose-200">БОЕВОЙ РЕЖИМ: сообщения будут реально отправлены.</span>
            )
          ) : (
            <span>Реальная отправка выключена (kill switch).</span>
          )}
        </div>
        <ManualActions />
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card title="Последние кейсы">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-white/60">
                <tr>
                  <th className="py-2">last_missed_at</th>
                  <th className="py-2">status</th>
                  <th className="py-2">phone</th>
                  <th className="py-2">manager</th>
                  <th className="py-2">deal</th>
                  <th className="py-2">missed</th>
                </tr>
              </thead>
              <tbody className="text-white/80">
                {cases.map((c) => (
                  <tr key={c.id} className="border-t border-white/10">
                    <td className="py-2">{String(c.last_missed_at ?? "")}</td>
                    <td className="py-2">{String(c.status ?? "")}</td>
                    <td className="py-2">{String(c.phone_normalized ?? "")}</td>
                    <td className="py-2">{String(c.manager_name ?? "")}</td>
                    <td className="py-2">{c.deal_id ?? ""}</td>
                    <td className="py-2">{c.missed_count ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <Card title="Последние доставки">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-white/60">
                <tr>
                  <th className="py-2">created_at</th>
                  <th className="py-2">case</th>
                  <th className="py-2">role</th>
                  <th className="py-2">status</th>
                  <th className="py-2">error</th>
                  <th className="py-2">preview</th>
                </tr>
              </thead>
              <tbody className="text-white/80">
                {deliveries.map((d) => (
                  <tr key={d.id} className="border-t border-white/10 align-top">
                    <td className="py-2">{String(d.created_at ?? "")}</td>
                    <td className="py-2">{String(d.case_id ?? "")}</td>
                    <td className="py-2">{String(d.recipient_role ?? "")}</td>
                    <td className="py-2">
                      <DeliveryStatusCell status={d.delivery_status} />
                    </td>
                    <td className="py-2 max-w-[24ch]">
                      {d.error_message ? (
                        <div
                          className="whitespace-pre-wrap break-words text-xs text-white/70"
                          title={String(d.error_message)}
                        >
                          {String(d.error_message)}
                        </div>
                      ) : (
                        <span className="text-white/40">—</span>
                      )}
                    </td>
                    <td className="py-2">
                      <div className="line-clamp-3 max-w-[40ch] whitespace-pre-wrap text-white/70">
                        {String(d.message_text ?? "")}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>

      <Card title="Последние mirror deliveries">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="text-white/60">
              <tr>
                <th className="py-2">created_at</th>
                <th className="py-2">delivery_id</th>
                <th className="py-2">mirror_user</th>
                <th className="py-2">status</th>
                <th className="py-2">preview</th>
              </tr>
            </thead>
            <tbody className="text-white/80">
              {mirrorDeliveries.map((m) => (
                <tr key={m.id} className="border-t border-white/10 align-top">
                  <td className="py-2">{String(m.created_at ?? "")}</td>
                  <td className="py-2">{String(m.delivery_id ?? "")}</td>
                  <td className="py-2">{String(m.mirror_bitrix_user_id ?? "")}</td>
                  <td className="py-2">{String(m.delivery_status ?? "")}</td>
                  <td className="py-2">
                    <div className="line-clamp-3 max-w-[60ch] whitespace-pre-wrap text-white/70">
                      {String(m.message_text ?? "")}
                    </div>
                    {m.error_message ? (
                      <div className="mt-1 text-rose-200">{String(m.error_message)}</div>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="Health / warnings">
        <ul className="list-disc space-y-1 pl-5 text-sm text-white/70">
          {settings.sending_enabled && !settings.dry_run_mode ? (
            <li className="text-rose-200">
              Система в боевом режиме: отправка включена и dry run выключен.
            </li>
          ) : (
            <li>Безопасный режим: реальная отправка выключена или dry run включен.</li>
          )}
          {summary.pendingDeliveries > 0 ? (
            <li>Есть pending deliveries: {summary.pendingDeliveries}</li>
          ) : (
            <li>Pending deliveries: 0</li>
          )}
          {summary.failedCallEventProcessing > 0 ? (
            <li className="text-rose-200">
              Есть failed call_event processing: {summary.failedCallEventProcessing}
            </li>
          ) : (
            <li>Failed call_event processing: 0</li>
          )}
          <li>
            Последняя сборка иерархии:{" "}
            <span className="text-white/80">{summary.lastOrgResolvedAt ?? "нет данных"}</span>
          </li>
          <li>
            Open SLA executions:{" "}
            <span className="text-white/80">{summary.openSlaExecutions}</span>
          </li>
        </ul>
      </Card>
    </main>
  );
}

