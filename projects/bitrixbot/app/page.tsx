import { envStatus } from "@/lib/env";

function StatusRow({
  label,
  ok,
  detail
}: {
  label: string;
  ok: boolean;
  detail?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-6 rounded-lg border border-white/10 bg-white/5 px-4 py-3">
      <div className="text-sm text-white/80">{label}</div>
      <div className="flex items-center gap-3">
        {detail ? <div className="text-xs text-white/50">{detail}</div> : null}
        <div
          className={[
            "text-xs font-medium",
            ok ? "text-emerald-300" : "text-rose-300"
          ].join(" ")}
        >
          {ok ? "OK" : "НЕ ЗАДАНО"}
        </div>
      </div>
    </div>
  );
}

export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-8 px-6 py-12">
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">Bitrixbot</h1>
        <p className="text-white/70">Контроль пропущенных звонков</p>
      </header>

      <section className="space-y-3">
        <StatusRow
          label="Supabase подключен"
          ok={envStatus.supabaseConfigured}
          detail="NEXT_PUBLIC_SUPABASE_URL"
        />
        <StatusRow
          label="Bitrix REST задан"
          ok={envStatus.bitrixRestConfigured}
          detail="BITRIX_REST_BASE_URL"
        />
      </section>
    </main>
  );
}

