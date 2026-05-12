"use client";

import { useActionState } from "react";
import {
  runManualAction,
  type ManualActionState
} from "./actions";

function JsonPreview({ value }: { value: unknown }) {
  if (!value) return null;
  const text = JSON.stringify(value, null, 2);
  return (
    <pre className="mt-3 max-h-96 overflow-auto rounded-md border border-white/10 bg-black/30 p-3 text-xs text-white/80">
      {text}
    </pre>
  );
}

export function ManualActions() {
  const initial: ManualActionState = {
    ok: true,
    action: null,
    limit: null,
    startedAt: null,
    durationMs: null,
    result: null,
    error: null
  };
  const [state, action, isPending] = useActionState<ManualActionState, FormData>(
    runManualAction,
    initial
  );

  return (
    <div>
      <form action={action} className="flex flex-col gap-3 md:flex-row md:items-end">
        <div className="flex-1">
          <div className="text-sm text-white/70">Action</div>
          <select
            name="action"
            className="mt-1 w-full rounded-md border border-white/10 bg-black/20 px-3 py-2 text-sm"
            defaultValue="run_full_cycle"
          >
            <option value="run_full_cycle">Запустить полный цикл</option>
            <option value="rebuild_hierarchy">Пересобрать иерархию</option>
            <option value="process_missed_calls">Обработать новые missed calls</option>
            <option value="process_callback_resolution">Проверить callback resolution</option>
            <option value="process_no_callback_escalations">Проверить no-callback escalations</option>
            <option value="process_pending_deliveries">Отправить pending deliveries</option>
          </select>
        </div>
        <div className="w-40">
          <div className="text-sm text-white/70">Limit</div>
          <input
            name="limit"
            type="number"
            defaultValue={100}
            className="mt-1 w-full rounded-md border border-white/10 bg-black/20 px-3 py-2 text-sm"
          />
        </div>
        <button
          disabled={isPending}
          className="rounded-md bg-white/10 px-4 py-2 text-sm hover:bg-white/15 disabled:opacity-60"
        >
          {isPending ? "Запуск..." : "Запустить"}
        </button>
      </form>

      <p className="mt-2 text-xs text-white/50">
        Полный цикл: иерархия → missed calls → callback → no-callback SLA → pending deliveries (sender
        учитывает kill switch, dry run, mirror-only).
      </p>

      {state.action ? (
        <div className="mt-3 text-xs text-white/60">
          {state.ok ? "OK" : "ERROR"} ·{" "}
          {state.action === "run_full_cycle"
            ? "run_full_cycle (полный цикл)"
            : state.action}{" "}
          · limit={state.limit} · {state.durationMs ?? 0}ms
          {state.error ? <div className="mt-1 text-rose-200">{state.error}</div> : null}
        </div>
      ) : null}

      <JsonPreview value={state.result} />
    </div>
  );
}

