"use client";

import { useEffect, useMemo, useState } from "react";
import { renderMessageTemplate } from "@/src/lib/bitrixbot/render-message-template";
import type { AlertNotificationRuleRow } from "@/src/lib/bitrixbot/alert-notification-rule-engine";
import {
  deleteAlertNotificationRuleAction,
  duplicateAlertNotificationRuleAction,
  moveAlertNotificationRuleAction,
  saveAlertNotificationRuleAction
} from "./server-actions";

const SAMPLE = {
  message: "СРОЧНО ПЕРЕЗВОНИ КЛИЕНТУ.",
  manager_name: "Иван Иванов",
  phone: "+79001234567",
  missed_at: "2026-05-13T10:15:00+03:00",
  case_id: "00000000-0000-4000-8000-000000000001",
  contact_name: "ООО Ромашка",
  missed_count: 2,
  minutes_without_callback: "15",
  recipient_role: "rop",
  recipient_name: "РОП Примеров"
};

function conditionHuman(
  r: Pick<AlertNotificationRuleRow, "missed_count_threshold" | "no_callback_minutes" | "condition_operator">
): string {
  const parts: string[] = [];
  if (r.missed_count_threshold != null) {
    parts.push(`пропущенных подряд ≥ ${r.missed_count_threshold}`);
  }
  if (r.no_callback_minutes != null) {
    parts.push(`нет исходящего ≥ ${r.no_callback_minutes} мин`);
  }
  if (parts.length === 0) return "условия не заданы (правило не сработает)";
  const op = r.condition_operator === "AND" ? " И " : " ИЛИ ";
  return parts.join(op);
}

function recipientsHuman(recipients: unknown): string {
  try {
    const arr = Array.isArray(recipients) ? recipients : [];
    const labels: string[] = [];
    for (const x of arr) {
      if (!x || typeof x !== "object") continue;
      const t = (x as { type?: string }).type;
      if (t === "responsible_manager") labels.push("Ответственный менеджер");
      else if (t === "rop") labels.push("РОП");
      else if (t === "director") labels.push("Директор");
      else if (t === "manual_user_id")
        labels.push(`Ручной id ${String((x as { userId?: string }).userId ?? "")}`);
    }
    return labels.length ? labels.join(", ") : "—";
  } catch {
    return "—";
  }
}

function RuleEditor({ rule }: { rule: AlertNotificationRuleRow }) {
  const [conditionOperator, setConditionOperator] = useState(rule.condition_operator);
  useEffect(() => {
    setConditionOperator(rule.condition_operator);
  }, [rule.id, rule.condition_operator, rule.updated_at]);

  const [manualIds, setManualIds] = useState<string[]>(() => {
    const arr = Array.isArray(rule.recipients) ? rule.recipients : [];
    const ids: string[] = [];
    for (const x of arr) {
      if (x && typeof x === "object" && (x as { type?: string }).type === "manual_user_id") {
        const id = String((x as { userId?: string }).userId ?? "").trim();
        if (id) ids.push(id);
      }
    }
    return ids;
  });
  const [newId, setNewId] = useState("");

  const flags = useMemo(() => {
    const arr = Array.isArray(rule.recipients) ? rule.recipients : [];
    let m = false,
      rop = false,
      dir = false;
    for (const x of arr) {
      if (!x || typeof x !== "object") continue;
      const t = (x as { type?: string }).type;
      if (t === "responsible_manager") m = true;
      if (t === "rop") rop = true;
      if (t === "director") dir = true;
    }
    return { m, rop, dir };
  }, [rule.recipients]);

  const preview = useMemo(
    () => renderMessageTemplate(rule.message_template, SAMPLE),
    [rule.message_template]
  );

  return (
    <section key={`${rule.id}:${rule.updated_at ?? ""}`} className="rounded-xl border border-white/10 bg-white/5 p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-white/90">{rule.name}</h3>
        <div className="flex flex-wrap gap-2">
          <form action={duplicateAlertNotificationRuleAction}>
            <input type="hidden" name="id" value={rule.id} />
            <button
              type="submit"
              className="rounded-md border border-white/15 px-2 py-1 text-xs hover:bg-white/10"
            >
              Дублировать
            </button>
          </form>
          <form action={moveAlertNotificationRuleAction}>
            <input type="hidden" name="id" value={rule.id} />
            <input type="hidden" name="direction" value="up" />
            <button
              type="submit"
              className="rounded-md border border-white/15 px-2 py-1 text-xs hover:bg-white/10"
            >
              ↑
            </button>
          </form>
          <form action={moveAlertNotificationRuleAction}>
            <input type="hidden" name="id" value={rule.id} />
            <input type="hidden" name="direction" value="down" />
            <button
              type="submit"
              className="rounded-md border border-white/15 px-2 py-1 text-xs hover:bg-white/10"
            >
              ↓
            </button>
          </form>
          <form
            action={deleteAlertNotificationRuleAction}
            onSubmit={(e) => {
              if (!confirm("Удалить правило?")) e.preventDefault();
            }}
          >
            <input type="hidden" name="id" value={rule.id} />
            <button
              type="submit"
              className="rounded-md border border-rose-500/40 px-2 py-1 text-xs text-rose-100 hover:bg-rose-500/15"
            >
              Удалить
            </button>
          </form>
        </div>
      </div>

      <form action={saveAlertNotificationRuleAction} className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <input type="hidden" name="id" value={rule.id} />
        <input type="hidden" name="manual_user_ids" value={manualIds.join(",")} readOnly />

        <label className="flex flex-col text-xs text-white/50 lg:col-span-2">
          Название
          <input
            name="name"
            defaultValue={rule.name}
            required
            className="mt-1 rounded-md border border-white/10 bg-black/25 px-2 py-1.5 text-sm text-white"
          />
        </label>
        <label className="flex items-center gap-2 text-sm text-white/80">
          <input type="checkbox" name="enabled" defaultChecked={rule.enabled} />
          Активно
        </label>
        <label className="flex flex-col text-xs text-white/50">
          sort_order
          <input
            name="sort_order"
            type="number"
            defaultValue={rule.sort_order}
            className="mt-1 rounded-md border border-white/10 bg-black/25 px-2 py-1.5 text-sm text-white"
          />
        </label>
        <label className="flex flex-col text-xs text-white/50">
          Порог пропущенных подряд (пусто = не использовать)
          <input
            name="missed_count_threshold"
            type="number"
            defaultValue={rule.missed_count_threshold ?? ""}
            placeholder="например 2"
            className="mt-1 rounded-md border border-white/10 bg-black/25 px-2 py-1.5 text-sm text-white"
          />
        </label>
        <label className="flex flex-col text-xs text-white/50">
          Минут без исходящего после пропуска (пусто = не использовать)
          <input
            name="no_callback_minutes"
            type="number"
            defaultValue={rule.no_callback_minutes ?? ""}
            placeholder="например 15"
            className="mt-1 rounded-md border border-white/10 bg-black/25 px-2 py-1.5 text-sm text-white"
          />
        </label>
        <label className="flex flex-col text-xs text-white/50">
          Логика между условиями
          <select
            name="condition_operator"
            value={conditionOperator}
            onChange={(e) => setConditionOperator(e.target.value === "AND" ? "AND" : "OR")}
            className="mt-1 rounded-md border border-white/10 bg-black/25 px-2 py-1.5 text-sm text-white"
          >
            <option value="AND">AND</option>
            <option value="OR">OR</option>
          </select>
        </label>

        <div className="lg:col-span-2 rounded-md border border-white/10 bg-black/20 p-3">
          <div className="mb-2 text-xs font-medium text-white/70">Получатели</div>
          <div className="flex flex-wrap gap-4 text-sm">
            <label className="flex items-center gap-2">
              <input type="checkbox" name="recipient_manager" defaultChecked={flags.m} />
              Ответственный менеджер
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" name="recipient_rop" defaultChecked={flags.rop} />
              РОП
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" name="recipient_director" defaultChecked={flags.dir} />
              Директор
            </label>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <input
              value={newId}
              onChange={(e) => setNewId(e.target.value)}
              placeholder="Bitrix user id"
              className="min-w-[8rem] flex-1 rounded-md border border-white/10 bg-black/25 px-2 py-1 text-sm text-white"
            />
            <button
              type="button"
              className="rounded-md bg-white/10 px-3 py-1 text-sm"
              onClick={() => {
                const t = newId.trim();
                if (!t) return;
                setManualIds((prev) => [...prev, t]);
                setNewId("");
              }}
            >
              Добавить user_id
            </button>
          </div>
          <ul className="mt-2 space-y-1 text-xs text-white/80">
            {manualIds.map((id) => (
              <li key={id} className="flex items-center justify-between gap-2 rounded bg-black/30 px-2 py-1 font-mono">
                {id}
                <button
                  type="button"
                  className="text-rose-200 hover:underline"
                  onClick={() => setManualIds((prev) => prev.filter((x) => x !== id))}
                >
                  удалить
                </button>
              </li>
            ))}
          </ul>
        </div>

        <label className="flex flex-col text-xs text-white/50 lg:col-span-2">
          Шаблон сообщения
          <textarea
            name="message_template"
            rows={8}
            defaultValue={rule.message_template}
            className="mt-1 w-full rounded-md border border-white/10 bg-black/25 px-2 py-1.5 font-mono text-xs text-white"
          />
        </label>

        <div className="lg:col-span-2 flex flex-wrap gap-2">
          <button type="submit" className="rounded-md bg-emerald-600/80 px-4 py-2 text-sm text-white hover:bg-emerald-500">
            Сохранить
          </button>
        </div>
      </form>

      <div className="mt-4 grid grid-cols-1 gap-3 border-t border-white/10 pt-4 md:grid-cols-2">
        <div>
          <div className="text-[11px] font-medium text-white/55">Условие (читаемо)</div>
          <p className="mt-1 text-sm text-white/85">{conditionHuman(rule)}</p>
          <div className="mt-2 text-[11px] font-medium text-white/55">Получатели</div>
          <p className="mt-1 text-sm text-white/85">{recipientsHuman(rule.recipients)}</p>
        </div>
        <div>
          <div className="text-[11px] font-medium text-white/55">Preview</div>
          <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded-md border border-white/10 bg-black/30 p-2 text-xs text-white/80">
            {preview || "—"}
          </pre>
        </div>
      </div>
    </section>
  );
}

export function NotificationRulesPanel(props: { rules: AlertNotificationRuleRow[] }) {
  const sorted = useMemo(
    () => [...props.rules].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)),
    [props.rules]
  );

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-white/70">
        Правила из таблицы <code className="text-white/80">alert_notification_rules</code> (конструктор missed-call
        alerting). Устаревшие <code className="text-white/80">notification_rules</code> /{" "}
        <code className="text-white/80">process-no-callback-escalations</code> — отдельная цепочка. Порядок —{" "}
        <code className="text-white/80">sort_order</code> (меньше = раньше). Поле{" "}
        <code className="text-white/80">condition_operator</code> задаёт AND/OR между порогом пропущенных и минутами без
        успешного перезвона. Дедуп доставок:{" "}
        <code className="text-white/80">case_id + alert_rule_id + recipient_bitrix_user_id</code>. Успешный callback
        помечает кейс <code className="text-white/80">resolved_after_contact</code> (см. resolve-missed-call-case-by-callback).
      </p>
      <form action={saveAlertNotificationRuleAction} className="flex flex-wrap items-end gap-2 rounded-lg border border-dashed border-white/15 p-3">
        <input type="hidden" name="create" value="1" />
        <label className="flex flex-col text-xs text-white/50">
          Новое правило — название
          <input
            name="name"
            required
            placeholder="Например: Эскалация — директору"
            className="mt-1 min-w-[14rem] rounded-md border border-white/10 bg-black/25 px-2 py-1.5 text-sm text-white"
          />
        </label>
        <button type="submit" className="rounded-md bg-white/12 px-4 py-2 text-sm hover:bg-white/18">
          Добавить правило
        </button>
      </form>
      <div className="flex flex-col gap-4">
        {sorted.map((r) => (
          <RuleEditor key={`${r.id}:${r.updated_at ?? ""}`} rule={r} />
        ))}
      </div>
    </div>
  );
}
