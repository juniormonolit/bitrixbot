"use client";

import { useMemo, useState } from "react";
import { renderMessageTemplate } from "@/src/lib/bitrixbot/render-message-template";
import type { AlertingDashboardSummary } from "@/src/lib/bitrixbot/alerting-dashboard";
import {
  alertingModeLabel,
  deriveAlertingMode,
  DEFAULT_MIRROR_BITRIX_USER_ID
} from "@/src/lib/bitrixbot/alerting-mode";
import type { AlertingSettings } from "@/src/lib/bitrixbot/get-alerting-settings";
import type { CallEventManagerDiagnostics } from "@/src/lib/bitrixbot/call-event-manager-diagnostics";
import type { AlertNotificationRuleRow } from "@/src/lib/bitrixbot/alert-notification-rule-engine";
import { ManualActions } from "./manual-actions";
import { OrgHierarchyBrowser } from "./org-hierarchy-browser";
import { NotificationRulesPanel } from "./notification-rules-panel";
import {
  applyAlertingModeAction,
  resetMessageTemplateByCodeAction,
  saveMessageTemplateAction,
  saveOrgAutoRefreshAction,
  stopAllSendingsAction
} from "./server-actions";

export type CaseRow = {
  id: string;
  status: string;
  phone_normalized: string;
  manager_name: string | null;
  deal_id: number | null;
  missed_count: number;
  last_missed_at: string;
};

export type DeliveryRow = {
  id: string;
  created_at: string;
  case_id: string;
  recipient_role: string;
  recipient_name: string | null;
  recipient_bitrix_user_id: string | null;
  delivery_status: string;
  message_text: string;
  error_message: string | null;
};

export type MirrorDeliveryRow = {
  id: string;
  created_at: string;
  delivery_id: string;
  mirror_bitrix_user_id: string;
  delivery_status: string;
  error_message: string | null;
  message_text: string;
};

export type TemplatePanelRow = {
  id: string;
  code: string;
  name: string | null;
  body: string;
  target_role: string;
};

export type OrgHierarchyRow = import("./org-hierarchy-browser").OrgHierarchyRow;
export type OrgHierarchyStats = import("./org-hierarchy-browser").OrgHierarchyStats;

export type AlertRulesReadiness = {
  enabledRulesCount: number;
  hasResponsibleManagerRule: boolean;
  tableMissing: boolean;
};

export type OrgStructureSnapshot = {
  employeeCount: number;
  hierarchyRowCount: number;
  hierarchyRows: OrgHierarchyRow[];
  hierarchyStats: OrgHierarchyStats;
};

type TabId = "mode" | "rules" | "logs" | "org";

const PENDING_DELIVERIES_WARN_THRESHOLD = 200;

const SAMPLE_TEMPLATE_VALUES = {
  message: "СРОЧНО ПЕРЕЗВОНИ КЛИЕНТУ. ДО ТЕБЯ НЕ ДОЗВОНИЛИСЬ.",
  manager_name: "Иван Иванов",
  phone: "+79001234567",
  missed_at: "2026-05-13T10:15:00+03:00",
  case_id: "00000000-0000-4000-8000-000000000001",
  main_recipient: "Иван Иванов (manager)",
  missed_count: 2,
  minutes_without_callback: "15",
  recipient_role: "manager",
  recipient_name: "Иван Иванов",
  contact_name: "ООО Ромашка"
};

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
          Не отправлено основному (mirror-only)
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

function TabButton({
  active,
  children,
  onClick
}: {
  active: boolean;
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        "rounded-lg px-4 py-2 text-sm font-medium transition-colors",
        active
          ? "bg-white/15 text-white"
          : "text-white/65 hover:bg-white/10 hover:text-white/90"
      ].join(" ")}
    >
      {children}
    </button>
  );
}

function TemplateSection(props: {
  title: string;
  description: string;
  template: TemplatePanelRow | null;
  variablesNote: string;
}) {
  const preview = useMemo(() => {
    if (!props.template?.body) return "";
    return renderMessageTemplate(props.template.body, SAMPLE_TEMPLATE_VALUES);
  }, [props.template]);

  if (!props.template) {
    return (
      <Card title={props.title}>
        <p className="text-sm text-amber-100/90">{props.description}</p>
        <p className="mt-2 text-xs text-white/50">Шаблон в БД не найден (target_role).</p>
      </Card>
    );
  }

  return (
    <Card title={props.title}>
      <p className="mb-2 text-xs text-white/55">{props.description}</p>
      <p className="mb-2 text-[11px] text-white/45">{props.variablesNote}</p>
      <form action={saveMessageTemplateAction} className="space-y-3">
        <input type="hidden" name="template_id" value={props.template.id} />
        <textarea
          name="body"
          rows={6}
          defaultValue={props.template.body}
          className="w-full rounded-md border border-white/10 bg-black/25 px-3 py-2 font-mono text-xs text-white/90"
        />
        <div className="flex flex-wrap gap-2">
          <button
            type="submit"
            className="rounded-md bg-white/10 px-4 py-2 text-sm hover:bg-white/15"
          >
            Сохранить
          </button>
        </div>
      </form>
      <form action={resetMessageTemplateByCodeAction} className="mt-2">
        <input type="hidden" name="template_id" value={props.template.id} />
        <input type="hidden" name="code" value={props.template.code} />
        <button
          type="submit"
          className="rounded-md border border-white/15 px-4 py-2 text-sm text-white/75 hover:bg-white/10"
        >
          Сбросить к дефолту
        </button>
      </form>
      <div className="mt-3">
        <div className="text-xs text-white/50">Preview (тестовые данные)</div>
        <div className="mt-1 max-w-full overflow-hidden rounded-md border border-white/10 bg-black/30 p-3 text-xs text-white/80 [overflow-wrap:anywhere] whitespace-pre-line">
          {preview || "—"}
        </div>
      </div>
    </Card>
  );
}

export function AlertingConsole(props: {
  secret: string;
  settings: AlertingSettings;
  summary: AlertingDashboardSummary;
  cases: CaseRow[];
  deliveries: DeliveryRow[];
  mirrorDeliveries: MirrorDeliveryRow[];
  templates: { manager: TemplatePanelRow | null; rop: TemplatePanelRow | null };
  orgSnapshot: OrgStructureSnapshot;
  managerCallDiagnostics: CallEventManagerDiagnostics;
  alertRules: AlertNotificationRuleRow[];
  alertRulesReadiness: AlertRulesReadiness;
}) {
  const [tab, setTab] = useState<TabId>("mode");
  const mode = deriveAlertingMode(props.settings);
  const killSwitchOff = !props.settings.sending_enabled;

  const mirrorPreview = useMemo(() => {
    const original =
      "Пример текста основного уведомления — как в delivery после рендера шаблона.";
    return [
      "[Дубль уведомления]",
      "Основной получатель: Иван Иванов (manager) (42)",
      `Case ID: ${SAMPLE_TEMPLATE_VALUES.case_id}`,
      "",
      original
    ].join("\n");
  }, []);

  const varsNote =
    "Переменные: {message}, {manager_name}, {phone}, {missed_at}, {case_id}, {contact_name}, {missed_count}, {minutes_without_callback}, {recipient_role}, {recipient_name}, {main_recipient} — также {{...}} (устаревшие deal_* подставляются пустыми). Переносы: в БД могут быть \\n; preview и отправка нормализуются в реальные переводы строк.";

  return (
    <main className="mx-auto flex min-h-screen max-w-6xl flex-col gap-6 px-6 py-10">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold">Консоль alerting</h1>
        <p className="text-sm text-white/55">
          Режим и флаги читаются из одной записи{" "}
          <code className="text-white/75">alerting_settings</code> — UI и backend используют одинаковые значения.
        </p>
      </header>

      <nav className="flex flex-wrap gap-2 rounded-xl border border-white/10 bg-black/20 p-2">
        <TabButton active={tab === "mode"} onClick={() => setTab("mode")}>
          Режим работы
        </TabButton>
        <TabButton active={tab === "rules"} onClick={() => setTab("rules")}>
          Правила уведомлений
        </TabButton>
        <TabButton active={tab === "logs"} onClick={() => setTab("logs")}>
          Логи
        </TabButton>
        <TabButton active={tab === "org"} onClick={() => setTab("org")}>
          Структура компании
        </TabButton>
      </nav>

      {tab === "mode" ? (
        <div className="flex flex-col gap-6">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <Card title="Текущий режим">
              <div className="text-sm font-medium text-white/90">{alertingModeLabel(mode)}</div>
              {mode === "custom" ? (
                <p className="mt-2 text-xs text-amber-100/90">
                  Выберите один из пресетов ниже или выровняйте флаги вручную через API/БД.
                </p>
              ) : null}
            </Card>
            <Card title="Отправка">
              <Badge ok={props.settings.sending_enabled} label={props.settings.sending_enabled ? "ВКЛ" : "ВЫКЛ"} />
            </Card>
            <Card title="Mirror user id">
              <div className="font-mono text-sm text-white/85">
                {props.settings.mirror_bitrix_user_id != null
                  ? String(props.settings.mirror_bitrix_user_id)
                  : "—"}
              </div>
              <div className="mt-1 text-[10px] text-white/45">Дефолт пресетов: {DEFAULT_MIRROR_BITRIX_USER_ID}</div>
            </Card>
            <Card title="Pending deliveries">
              <div className="text-2xl font-semibold">{props.summary.pendingDeliveries}</div>
            </Card>
            <Card title="Failed deliveries">
              <div className="text-2xl font-semibold text-rose-100/90">{props.summary.failedDeliveries}</div>
            </Card>
            <Card title="Failed mirrors">
              <div className="text-2xl font-semibold text-rose-100/90">{props.summary.failedMirrors}</div>
            </Card>
          </div>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <Card title="Sent (24h)">
              <div className="text-2xl font-semibold">{props.summary.sentDeliveries24h}</div>
            </Card>
            <Card title="Open SLA">
              <div className="text-2xl font-semibold">{props.summary.openSlaExecutions}</div>
            </Card>
          </div>

          <Card title="Перед боевым режимом — чеклист">
            <p className="mb-3 text-xs text-white/55">
              Проверьте пункты перед включением боевого режима (сообщения реальным ответственным).
            </p>
            <ul className="space-y-2 text-sm text-white/80">
              <li className="flex flex-wrap gap-2">
                <span>{props.orgSnapshot.employeeCount > 0 ? "✓" : "○"}</span>
                <span>
                  employees sync: в таблице <code className="text-white/70">employees</code>{" "}
                  {props.orgSnapshot.employeeCount > 0 ? (
                    <span className="text-emerald-100/90">{props.orgSnapshot.employeeCount} записей</span>
                  ) : (
                    <span className="text-amber-100/90">нет строк — проверьте синхронизацию</span>
                  )}
                </span>
              </li>
              <li className="flex flex-wrap gap-2">
                <span>{props.managerCallDiagnostics.missingFromEmployees === 0 ? "✓" : "○"}</span>
                <span>
                  manager ids в выборке:{" "}
                  {props.managerCallDiagnostics.missingFromEmployees === 0 ? (
                    <span className="text-emerald-100/90">все найдены в employees</span>
                  ) : (
                    <span className="text-amber-100/90">
                      {props.managerCallDiagnostics.missingFromEmployees} id без employees — см. блок ниже на вкладке
                      «Структура»
                    </span>
                  )}
                </span>
              </li>
              <li className="flex flex-wrap gap-2">
                <span>
                  {!props.alertRulesReadiness.tableMissing && props.alertRulesReadiness.enabledRulesCount > 0
                    ? "✓"
                    : "○"}
                </span>
                <span>
                  правила включены:{" "}
                  {props.alertRulesReadiness.tableMissing ? (
                    <span className="text-amber-100/90">таблица правил недоступна или пуста</span>
                  ) : props.alertRulesReadiness.enabledRulesCount > 0 ? (
                    <span className="text-emerald-100/90">
                      активных правил: {props.alertRulesReadiness.enabledRulesCount}
                    </span>
                  ) : (
                    <span className="text-amber-100/90">нет включённых правил</span>
                  )}
                </span>
              </li>
              <li className="flex flex-wrap gap-2">
                <span>{props.alertRulesReadiness.hasResponsibleManagerRule ? "✓" : "○"}</span>
                <span>
                  есть активное правило с получателем «ответственный менеджер»:{" "}
                  {props.alertRulesReadiness.hasResponsibleManagerRule ? (
                    <span className="text-emerald-100/90">да</span>
                  ) : (
                    <span className="text-amber-100/90">нет — менеджер может не получать уведомления по правилам</span>
                  )}
                </span>
              </li>
              <li className="flex flex-wrap gap-2">
                <span>{props.summary.pendingDeliveries < PENDING_DELIVERIES_WARN_THRESHOLD ? "✓" : "○"}</span>
                <span>
                  pending deliveries не слишком много:{" "}
                  <span className={props.summary.pendingDeliveries < PENDING_DELIVERIES_WARN_THRESHOLD ? "text-emerald-100/90" : "text-amber-100/90"}>
                    {props.summary.pendingDeliveries} (порог предупреждения {PENDING_DELIVERIES_WARN_THRESHOLD})
                  </span>
                </span>
              </li>
            </ul>
            {!props.alertRulesReadiness.hasResponsibleManagerRule && !props.alertRulesReadiness.tableMissing ? (
              <p className="mt-3 rounded-md border border-amber-500/35 bg-amber-500/10 p-2 text-xs text-amber-100">
                Предупреждение: среди <strong>включённых</strong> правил нет ни одного с получателем «Ответственный
                менеджер». Первый уровень эскалации может не дойти до менеджера.
              </p>
            ) : null}
          </Card>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <Card title="Режим 1: Боевой">
              <p className="mb-3 text-sm text-white/75">
                Сообщения отправляются ответственным менеджерам как положено.
              </p>
              <div className="mb-3 rounded-md border border-rose-500/35 bg-rose-500/10 p-2 text-xs text-rose-100">
                Внимание: сообщения уйдут реальным ответственным.
              </div>
              <form action={applyAlertingModeAction} className="space-y-2">
                <input type="hidden" name="alerting_mode" value="live" />
                <label className="block text-xs text-white/50">Комментарий (опционально)</label>
                <input
                  name="updated_reason"
                  className="w-full rounded-md border border-white/10 bg-black/25 px-3 py-2 text-sm"
                  placeholder="причина смены режима"
                />
                <button
                  type="submit"
                  className="w-full rounded-md bg-emerald-600/80 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500"
                >
                  Применить боевой режим
                </button>
              </form>
            </Card>

            <Card title="Режим 2: Боевой + mirror">
              <p className="mb-3 text-sm text-white/75">
                Сообщения идут ответственным, копия уходит mirror-пользователю ({DEFAULT_MIRROR_BITRIX_USER_ID}).
              </p>
              <form action={applyAlertingModeAction} className="space-y-2">
                <input type="hidden" name="alerting_mode" value="live_with_mirror" />
                <label className="block text-xs text-white/50">Комментарий (опционально)</label>
                <input
                  name="updated_reason"
                  className="w-full rounded-md border border-white/10 bg-black/25 px-3 py-2 text-sm"
                  placeholder="причина смены режима"
                />
                <button type="submit" className="w-full rounded-md bg-white/12 px-4 py-2 text-sm hover:bg-white/18">
                  Применить режим с дублем
                </button>
              </form>
            </Card>

            <Card title="Режим 3: Только mirror">
              <p className="mb-3 text-sm text-white/75">
                Основным получателям сообщения не уходят. Все уведомления уходят только mirror-пользователю{" "}
                {DEFAULT_MIRROR_BITRIX_USER_ID}. Dry run не используется — отправка в Bitrix реальная, но только на mirror.
              </p>
              <form action={applyAlertingModeAction} className="space-y-2">
                <input type="hidden" name="alerting_mode" value="mirror_only" />
                <label className="block text-xs text-white/50">Комментарий (опционально)</label>
                <input
                  name="updated_reason"
                  className="w-full rounded-md border border-white/10 bg-black/25 px-3 py-2 text-sm"
                  placeholder="причина смены режима"
                />
                <button
                  type="submit"
                  className="w-full rounded-md bg-amber-500/25 px-4 py-2 text-sm font-medium text-amber-50 ring-1 ring-amber-400/35 hover:bg-amber-500/35"
                >
                  Применить только mirror
                </button>
              </form>
            </Card>
          </div>

          <Card title="СТОП ВСЕ ОТПРАВКИ">
            <p className="mb-3 text-sm text-white/70">
              Устанавливает <code className="text-white/85">sending_enabled=false</code>,{" "}
              <code className="text-white/85">dry_run_mode=true</code>. Перед сохранением укажите причину.
            </p>
            <form action={stopAllSendingsAction} className="flex max-w-xl flex-col gap-3">
              <input
                name="stop_reason"
                required
                className="rounded-md border border-white/10 bg-black/25 px-3 py-2 text-sm"
                placeholder="Причина остановки (обязательно)"
              />
              <button
                type="submit"
                className="w-fit rounded-md bg-rose-700 px-4 py-2 text-sm font-medium text-white hover:bg-rose-600"
              >
                СТОП ВСЕ ОТПРАВКИ
              </button>
            </form>
          </Card>

          <Card title="Контекст отправки">
            <div className="rounded-md border border-white/10 bg-black/25 p-3 text-xs text-white/75">
              {props.settings.sending_enabled ? (
                props.settings.dry_run_mode ? (
                  <span>Safe mode: dry run включён — реальная отправка заблокирована на стороне sender.</span>
                ) : props.settings.send_only_to_mirror ? (
                  <span className="text-amber-100">
                    Режим только mirror: основные получатели не получают сообщения (delivery skipped).
                  </span>
                ) : (
                  <span className="text-rose-100">
                    Боевой путь: сообщения могут уйти реальным ответственным.
                  </span>
                )
              ) : (
                <span>Kill switch: отправка выключена.</span>
              )}
            </div>
          </Card>

          <Card title="Ручные действия">
            <ManualActions debugSecret={props.secret} />
          </Card>
        </div>
      ) : null}

      {tab === "rules" ? (
        <div className="flex flex-col gap-6">
          <NotificationRulesPanel rules={props.alertRules} />
          <div className="text-xs text-white/45">
            Наследие: шаблоны <code className="text-white/65">message_templates</code> (роли manager/rop) могут
            использоваться другими путями; правила missed-call читаются из{" "}
            <code className="text-white/65">alert_notification_rules</code>.
          </div>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <TemplateSection
              title="[Legacy] Пропущенный — message_templates (manager)"
              description="Запись в message_templates для роли manager; не заменяет правила выше."
              template={props.templates.manager}
              variablesNote={varsNote}
            />
            <TemplateSection
              title="[Legacy] SLA / эскалация — message_templates (rop)"
              description="Запись для роли rop; не заменяет правила выше."
              template={props.templates.rop}
              variablesNote={varsNote}
            />
            <div className="lg:col-span-2">
              <Card title="Mirror-дубль">
                <p className="text-sm text-white/75">
                  Текст mirror-сообщения собирается в коде отправки (префикс «[Дубль уведомления]» + основной текст
                  delivery).
                </p>
                <div className="mt-3 text-xs text-white/50">Preview (структура как в коде)</div>
                <div className="mt-1 max-w-full overflow-hidden rounded-md border border-white/10 bg-black/30 p-3 text-xs text-white/80 [overflow-wrap:anywhere] whitespace-pre-line">
                  {mirrorPreview}
                </div>
              </Card>
            </div>
          </div>
        </div>
      ) : null}

      {tab === "logs" ? (
        <div className="flex flex-col gap-6">
          <Card title="Health / warnings">
            <ul className="list-disc space-y-1 pl-5 text-sm text-white/75">
              <li>
                Kill switch:{" "}
                <span className={killSwitchOff ? "text-amber-100" : "text-emerald-100"}>
                  {killSwitchOff ? "активен (отправка выключена)" : "не активен"}
                </span>
              </li>
              <li>Dry run: {props.settings.dry_run_mode ? "ВКЛ" : "ВЫКЛ"}</li>
              <li>Pending deliveries: {props.summary.pendingDeliveries}</li>
              <li>Failed deliveries: {props.summary.failedDeliveries}</li>
              <li>Failed processing (call_event): {props.summary.failedCallEventProcessing}</li>
              <li>Failed mirrors: {props.summary.failedMirrors}</li>
              <li>
                Последняя сборка иерархии:{" "}
                <span className="text-white/90">{props.summary.lastOrgResolvedAt ?? "нет данных"}</span>
              </li>
              <li>Open SLA executions: {props.summary.openSlaExecutions}</li>
            </ul>
          </Card>

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
                  {props.cases.map((c) => (
                    <tr key={c.id} className="border-t border-white/10">
                      <td className="py-2">{String(c.last_missed_at ?? "")}</td>
                      <td className="py-2">{String(c.status ?? "")}</td>
                      <td className="py-2">{String(c.phone_normalized ?? "")}</td>
                      <td className="py-2">{String(c.manager_name ?? "")}</td>
                      <td className="py-2">{String(c.deal_id ?? "")}</td>
                      <td className="py-2">{String(c.missed_count ?? "")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <Card title="Последние deliveries">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="text-white/60">
                    <tr>
                      <th className="py-2">created_at</th>
                      <th className="py-2">case</th>
                      <th className="py-2">role</th>
                      <th className="py-2">recipient</th>
                      <th className="py-2">status</th>
                      <th className="py-2">error</th>
                      <th className="py-2">preview</th>
                    </tr>
                  </thead>
                  <tbody className="text-white/80">
                    {props.deliveries.map((d) => (
                      <tr key={d.id} className="border-t border-white/10 align-top">
                        <td className="py-2 whitespace-nowrap">{String(d.created_at ?? "")}</td>
                        <td className="py-2 font-mono text-[10px]">{String(d.case_id ?? "")}</td>
                        <td className="py-2">{String(d.recipient_role ?? "")}</td>
                        <td className="max-w-[14ch] py-2 [overflow-wrap:anywhere] text-[11px]">
                          {d.recipient_name ?? "—"}{" "}
                          {d.recipient_bitrix_user_id != null ? (
                            <span className="text-white/50">({String(d.recipient_bitrix_user_id)})</span>
                          ) : null}
                        </td>
                        <td className="py-2">
                          <DeliveryStatusCell status={d.delivery_status} />
                        </td>
                        <td className="max-w-[min(18rem,40vw)] py-2 text-[11px] [overflow-wrap:anywhere] whitespace-pre-line text-rose-100/90">
                          {d.error_message ? String(d.error_message) : "—"}
                        </td>
                        <td className="max-w-[min(22rem,55vw)] py-2 text-[11px] [overflow-wrap:anywhere] whitespace-pre-line">
                          {String(d.message_text ?? "")}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>

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
                    {props.mirrorDeliveries.map((m) => (
                      <tr key={m.id} className="border-t border-white/10 align-top">
                        <td className="py-2 whitespace-nowrap">{String(m.created_at ?? "")}</td>
                        <td className="py-2 font-mono text-[10px]">{String(m.delivery_id ?? "")}</td>
                        <td className="py-2">{String(m.mirror_bitrix_user_id ?? "")}</td>
                        <td className="py-2">{String(m.delivery_status ?? "")}</td>
                        <td className="max-w-[min(28rem,70vw)] py-2 text-[11px] [overflow-wrap:anywhere] whitespace-pre-line">
                          {String(m.message_text ?? "")}
                          {m.error_message ? (
                            <div className="mt-1 whitespace-pre-line text-rose-200">{String(m.error_message)}</div>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          </div>
        </div>
      ) : null}

      {tab === "org" ? (
        <div className="flex flex-col gap-6">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <Card title="Последняя сборка иерархии">
              <div className="text-sm text-white/85">{props.summary.lastOrgResolvedAt ?? "нет данных"}</div>
            </Card>
            <Card title="Сотрудники (employees)">
              <div className="text-[10px] text-white/45">Всего строк в public.employees</div>
              <div className="text-2xl font-semibold">{props.orgSnapshot.employeeCount}</div>
            </Card>
            <Card title="Строк в org_resolved_hierarchy">
              <div className="text-[10px] text-white/45">После rebuild ≈ числу сотрудников с bitrix_user_id</div>
              <div className="text-2xl font-semibold">{props.orgSnapshot.hierarchyRowCount}</div>
            </Card>
          </div>
          {props.orgSnapshot.employeeCount > 0 &&
          props.orgSnapshot.hierarchyRowCount < props.orgSnapshot.employeeCount - 5 ? (
            <div className="rounded-lg border border-amber-500/35 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
              Строк в кеше иерархии ({props.orgSnapshot.hierarchyRowCount}) заметно меньше, чем сотрудников (
              {props.orgSnapshot.employeeCount}). Запустите rebuild и проверьте лимиты PostgREST — в коде пагинация
              исправлена (шаг по фактическому размеру chunk).
            </div>
          ) : null}

          <OrgHierarchyBrowser rows={props.orgSnapshot.hierarchyRows} stats={props.orgSnapshot.hierarchyStats} />

          <Card title="Проверка manager Bitrix user ids (последние missed inbound)">
            <p className="mb-3 text-xs text-white/55">
              Сравнение <code className="text-white/75">call_events.manager_bitrix_user_id</code> с таблицами{" "}
              {props.managerCallDiagnostics.lookedUpInTables.join(" · ")}. Всего строк в БД: employees={" "}
              {props.managerCallDiagnostics.employeesTableRowCount}, hierarchy={""}
              {props.managerCallDiagnostics.hierarchyCacheRowCount}.
            </p>
            <div className="mb-4 grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
              <div className="rounded-md border border-white/10 bg-black/20 p-2">
                <div className="text-[10px] text-white/45">Событий с manager id</div>
                <div className="text-lg font-semibold">{props.managerCallDiagnostics.recentCallEventsAnalyzed}</div>
              </div>
              <div className="rounded-md border border-white/10 bg-black/20 p-2">
                <div className="text-[10px] text-white/45">Уникальных manager id</div>
                <div className="text-lg font-semibold">{props.managerCallDiagnostics.uniqueManagerBitrixUserIds}</div>
              </div>
              <div className="rounded-md border border-white/10 bg-black/20 p-2">
                <div className="text-[10px] text-white/45">Найдено в employees</div>
                <div className="text-lg font-semibold text-emerald-100/90">
                  {props.managerCallDiagnostics.foundInEmployeesTable}
                </div>
              </div>
              <div className="rounded-md border border-amber-400/25 bg-amber-500/10 p-2">
                <div className="text-[10px] text-amber-100/80">Нет в employees</div>
                <div className="text-lg font-semibold text-amber-100">
                  {props.managerCallDiagnostics.missingFromEmployees}
                </div>
              </div>
            </div>
            <p className="mb-2 text-[11px] text-white/45">
              Точечная проверка:{" "}
              <code className="break-all text-white/70">
                /api/debug/alerting/org-lookup?secret=…&bitrixUserId=1933
              </code>
            </p>
            {props.managerCallDiagnostics.missingManagers.length === 0 ? (
              <p className="text-sm text-emerald-100/90">Все manager id из выборки есть в employees.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="text-white/60">
                    <tr>
                      <th className="py-2">manager_bitrix_user_id</th>
                      <th className="py-2">звонков</th>
                      <th className="py-2">в hierarchy</th>
                      <th className="py-2">sample phones</th>
                      <th className="py-2">sample occurred_at</th>
                      <th className="py-2">sample call_event_id</th>
                    </tr>
                  </thead>
                  <tbody className="text-white/80">
                    {props.managerCallDiagnostics.missingManagers.map((m) => (
                      <tr key={m.managerBitrixUserId} className="border-t border-white/10 align-top">
                        <td className="py-2 font-mono">{String(m.managerBitrixUserId)}</td>
                        <td className="py-2">{String(m.callCount)}</td>
                        <td className="py-2">{m.foundInHierarchy ? "да" : "нет"}</td>
                        <td className="max-w-[10rem] py-2 [overflow-wrap:anywhere] text-[11px]">
                          {m.samplePhones.join(", ") || "—"}
                        </td>
                        <td className="max-w-[12rem] py-2 whitespace-pre-wrap text-[10px] text-white/55">
                          {m.sampleOccurredAt.join("\n")}
                        </td>
                        <td className="max-w-[14rem] py-2 font-mono text-[10px] [overflow-wrap:anywhere]">
                          {m.sampleCallEventIds.join(", ")}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card title="Автообновление структуры">
            <p className="mb-3 text-sm text-white/70">
              По расписанию Vercel Cron вызывает{" "}
              <code className="text-white/85">GET /api/cron/org-structure-refresh</code> (см. vercel.json, по умолчанию
              04:00 UTC). Флаг ниже отключает запуск; время — подпись для админов (точное UTC/TODO в коде cron).
            </p>
            <form action={saveOrgAutoRefreshAction} className="flex max-w-md flex-col gap-3">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  name="org_structure_auto_refresh_enabled"
                  defaultChecked={props.settings.org_structure_auto_refresh_enabled}
                />
                Автоматически обновлять структуру компании
              </label>
              <label className="text-xs text-white/50">
                Время (отображение, по умолчанию 04:00)
                <input
                  name="org_structure_auto_refresh_time_local"
                  type="time"
                  defaultValue={props.settings.org_structure_auto_refresh_time_local.slice(0, 5) || "04:00"}
                  className="mt-1 w-full rounded-md border border-white/10 bg-black/25 px-3 py-2 text-sm"
                />
              </label>
              <button type="submit" className="w-fit rounded-md bg-white/12 px-4 py-2 text-sm hover:bg-white/18">
                Сохранить расписание
              </button>
            </form>
          </Card>

          <Card title="Обновить вручную">
            <p className="mb-3 text-sm text-white/70">
              Используйте блок «Ручные действия» на вкладке «Режим работы» → действие «Обновить структуру компании».
            </p>
          </Card>
        </div>
      ) : null}
    </main>
  );
}

