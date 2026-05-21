"use client";

import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";

const SYNC_ORG_FULL_URL = "/api/debug/alerting/sync-org-full";
const CLIENT_TIMEOUT_MS = 130_000;

export function SyncStructureNowButton({ debugSecret }: { debugSecret: string }) {
  const router = useRouter();
  const [isRunning, setIsRunning] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<unknown>(null);

  const onClick = useCallback(async () => {
    setIsRunning(true);
    setLastError(null);
    setLastResult(null);

    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), CLIENT_TIMEOUT_MS);

    try {
      const res = await fetch(SYNC_ORG_FULL_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-debug-secret": debugSecret
        },
        body: JSON.stringify({}),
        signal: controller.signal
      });

      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        const msg =
          json && typeof json === "object" && json !== null && "error" in json
            ? String((json as { error: unknown }).error)
            : `HTTP ${res.status}`;
        throw new Error(msg);
      }
      setLastResult(json);
      router.refresh();
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") {
        setLastError(`Таймаут ${CLIENT_TIMEOUT_MS / 1000} с — проверьте логи сервера.`);
      } else {
        setLastError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      window.clearTimeout(timeoutId);
      setIsRunning(false);
    }
  }, [debugSecret, router]);

  return (
    <div>
      <button
        type="button"
        onClick={onClick}
        disabled={isRunning}
        className="rounded-md bg-emerald-600/90 px-5 py-2.5 text-sm font-medium text-white hover:bg-emerald-600 disabled:opacity-60"
      >
        {isRunning ? "Синхронизация…" : "Синхронизировать сейчас"}
      </button>
      <p className="mt-2 text-xs text-white/50">
        Bitrix: отделы + сотрудники (в т.ч. логины через mlt.managers.list) → пересборка иерархии в Supabase.
      </p>

      {lastError ? (
        <div className="mt-3 rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-100">
          {lastError}
        </div>
      ) : null}

      {lastResult !== null ? (
        <details className="mt-3 rounded-md border border-white/10 bg-black/25">
          <summary className="cursor-pointer px-3 py-2 text-xs text-white/70">Результат синхронизации</summary>
          <pre className="max-h-64 overflow-auto border-t border-white/10 p-3 text-xs text-white/80">
            {JSON.stringify(lastResult, null, 2)}
          </pre>
        </details>
      ) : null}
    </div>
  );
}
