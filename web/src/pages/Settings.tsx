import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api, getToken, setToken } from "@/api/client";
import { useHealth } from "@/api/queries";
import { cn } from "@/lib/cn";

type TestState =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "ok"; version?: string; uptime?: number }
  | { kind: "auth" }
  | { kind: "err"; message: string };

export default function Settings() {
  const [params] = useSearchParams();
  const [token, setLocalToken] = useState(getToken());
  const [reveal, setReveal] = useState(false);
  const [test, setTest] = useState<TestState>({ kind: "idle" });
  const { data: health } = useHealth(0);

  const reason = params.get("reason");

  function save() {
    setToken(token.trim());
    setTest({ kind: "idle" });
  }

  async function tryConnection() {
    setTest({ kind: "pending" });
    setToken(token.trim());
    try {
      const h = await api.health({ silentAuth: true });
      setTest({ kind: "ok", version: h.version, uptime: h.uptime });
    } catch (e) {
      const err = e as { status?: number; message?: string };
      if (err.status === 401) setTest({ kind: "auth" });
      else setTest({ kind: "err", message: err.message ?? "request failed" });
    }
  }

  return (
    <div className="mx-auto w-full max-w-2xl px-6 py-12">
      <h1 className="font-mono text-display font-semibold tracking-tightish text-fg">
        settings
      </h1>
      <p className="mt-2 max-w-lg text-small text-muted">
        the bridge requires{" "}
        <span className="font-mono text-fg">x-bridge-internal-token</span>{" "}
        on every request — except when it runs with{" "}
        <span className="font-mono text-fg">--localhost-only</span>, where
        loopback bypasses auth.
      </p>

      {reason === "auth" && (
        <div className="mt-6 rounded-sm border border-status-doing/40 bg-status-doing/10 px-4 py-3 font-mono text-small text-status-doing">
          your last request was rejected with 401 — paste a fresh token below.
        </div>
      )}

      <section className="mt-10 rounded-sm border border-border bg-surface p-6">
        <label className="block">
          <span className="mb-1.5 block font-mono text-micro uppercase tracking-wideish text-muted">
            internal token
          </span>
          <div className="flex items-stretch gap-2">
            <input
              type={reveal ? "text" : "password"}
              value={token}
              onChange={(e) => setLocalToken(e.target.value)}
              placeholder="paste BRIDGE_INTERNAL_TOKEN…"
              className="flex-1 rounded-sm border border-border bg-bg px-3 py-2 font-mono text-base text-fg placeholder:text-muted-2 focus:border-accent focus:outline-none"
            />
            <button
              type="button"
              onClick={() => setReveal((v) => !v)}
              className="rounded-sm border border-border px-3 font-mono text-micro uppercase tracking-wideish text-muted hover:text-fg"
            >
              {reveal ? "hide" : "show"}
            </button>
          </div>
        </label>

        <div className="mt-4 flex items-center gap-2">
          <button
            type="button"
            onClick={save}
            className="rounded-sm border border-accent/40 bg-accent px-4 py-1.5 font-mono text-micro uppercase tracking-wideish text-bg"
          >
            save
          </button>
          <button
            type="button"
            onClick={tryConnection}
            className="rounded-sm border border-border px-4 py-1.5 font-mono text-micro uppercase tracking-wideish text-muted hover:border-border-strong hover:text-fg"
          >
            test connection
          </button>
        </div>

        {test.kind !== "idle" && (
          <div
            className={cn(
              "mt-4 rounded-sm border px-3 py-2 font-mono text-micro tracking-wideish",
              test.kind === "ok" &&
                "border-status-done/40 bg-status-done/10 text-status-done",
              test.kind === "auth" &&
                "border-status-doing/40 bg-status-doing/10 text-status-doing",
              test.kind === "err" &&
                "border-status-blocked/40 bg-status-blocked/10 text-status-blocked",
              test.kind === "pending" && "border-border text-muted",
            )}
          >
            {test.kind === "pending" && "checking…"}
            {test.kind === "ok" &&
              `online — bridge ${test.version ?? "?"} · uptime ${formatUptime(test.uptime)}`}
            {test.kind === "auth" && "401 unauthorized — token rejected"}
            {test.kind === "err" && `error: ${test.message}`}
          </div>
        )}
      </section>

      <section className="mt-10 grid grid-cols-2 gap-4">
        <Card label="bridge version" value={health?.version ?? "—"} />
        <Card label="uptime" value={formatUptime(health?.uptime)} />
      </section>

      <p className="mt-10 text-small text-muted-2">
        token is stored in this browser only (
        <span className="font-mono">localStorage</span>). clearing site data
        wipes it.
      </p>
    </div>
  );
}

function Card({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-sm border border-border bg-surface p-4">
      <div className="font-mono text-micro uppercase tracking-wideish text-muted">
        {label}
      </div>
      <div className="mt-2 font-mono text-base tabular-nums text-fg">
        {value}
      </div>
    </div>
  );
}

function formatUptime(s: number | undefined): string {
  if (s === undefined || s === null) return "—";
  if (s < 60) return `${Math.floor(s)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
