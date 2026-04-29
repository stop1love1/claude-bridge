"use client";

import Image from "next/image";
import { useEffect, useState } from "react";
import { LogIn, ShieldCheck, KeyRound, Loader2 } from "lucide-react";
import { Button } from "../_components/ui/button";
import { Input } from "../_components/ui/input";
import { Label } from "../_components/ui/label";

/**
 * Single-user login screen. Two flows:
 *
 *   - **Setup** — when the bridge has no `auth` block in bridge.json
 *     yet, the page renders an in-UI form (email + password +
 *     confirm). The backend at `POST /api/auth/setup` enforces
 *     loopback-only + once-only semantics so a LAN visitor can't race
 *     to claim the password. On success the operator is auto-signed
 *     in (trust=true cookie) and redirected to `?next=…` (or `/`).
 *
 *   - **Login** — email + password + "Trust this device" toggle.
 *     On success the API sets `bridge_session` and we redirect to
 *     `?next=…` (or `/`).
 */
export default function LoginPage() {
  const [setupMode, setSetupMode] = useState<boolean | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [trust, setTrust] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    void (async () => {
      try {
        const r = await fetch("/api/auth/me", { cache: "no-store", signal: ac.signal });
        if (!r.ok) {
          if (!ac.signal.aborted) setSetupMode(false);
          return;
        }
        const data = (await r.json()) as { configured?: boolean; user?: unknown };
        if (ac.signal.aborted) return;
        // If the operator is already authed, redirect away — same UX
        // as most apps: the login page is a no-op for logged-in users.
        if (data.configured && data.user) {
          window.location.replace(nextDest());
          return;
        }
        setSetupMode(!data.configured);
      } catch {
        if (!ac.signal.aborted) setSetupMode(false);
      }
    })();
    return () => ac.abort();
  }, []);

  /** Pending-state info when login was held for trusted-device approval. */
  const [pending, setPending] = useState<{
    id: string;
    deviceLabel: string;
    expiresAt: string;
  } | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      const r = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password, trust }),
      });
      // 202 = device-approval gate. Server has accepted credentials but
      // is waiting for an existing trusted device to approve. Switch
      // the UI into a poll-and-wait state.
      if (r.status === 202) {
        const data = (await r.json()) as {
          pendingId: string;
          deviceLabel: string;
          expiresAt: string;
        };
        setPending({
          id: data.pendingId,
          deviceLabel: data.deviceLabel,
          expiresAt: data.expiresAt,
        });
        return;
      }
      if (!r.ok) {
        const text = await r.text();
        try {
          const parsed = JSON.parse(text) as { error?: string };
          setError(parsed.error || `Login failed (${r.status})`);
        } catch {
          setError(text || `Login failed (${r.status})`);
        }
        return;
      }
      window.location.replace(nextDest());
    } catch (err) {
      setError((err as Error).message || "Network error");
    } finally {
      setSubmitting(false);
    }
  };

  // While in pending state, poll the server every 2s for the operator's
  // decision. Stop on any non-202 response (approved → cookie set →
  // redirect; denied / expired → surface the reason and reset the form).
  useEffect(() => {
    if (!pending) return;
    const ac = new AbortController();
    const tick = async () => {
      try {
        const r = await fetch(`/api/auth/login/pending/${pending.id}`, {
          cache: "no-store",
          signal: ac.signal,
        });
        if (ac.signal.aborted) return;
        if (r.status === 202) return; // still pending — keep polling
        if (r.status === 200) {
          // approved + cookie attached
          window.location.replace(nextDest());
          return;
        }
        // 403 (denied), 410 (expired), other errors — surface message.
        let msg = `Login canceled (${r.status})`;
        try {
          const data = (await r.json()) as { reason?: string; status?: string };
          if (data.status === "denied") {
            msg = data.reason
              ? `Denied by another device: ${data.reason}`
              : "Denied by another device.";
          } else if (data.status === "expired") {
            msg = "The approval window expired. Try again.";
          } else if (data.reason) {
            msg = data.reason;
          }
        } catch { /* keep generic msg */ }
        setError(msg);
        setPending(null);
      } catch {
        // Abort during teardown OR a network blip — keep polling on
        // the next interval tick.
      }
    };
    const handle = setInterval(() => { void tick(); }, 2000);
    void tick();
    return () => {
      ac.abort();
      clearInterval(handle);
    };
  }, [pending]);

  if (setupMode === null) {
    return (
      <div className="min-h-screen flex items-center justify-center text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-4 bg-background">
      <div className="w-full max-w-sm rounded-lg border border-border bg-card shadow-lg p-6">
        <div className="flex items-center gap-3 mb-5">
          <Image src="/logo.svg" alt="" width={32} height={32} className="rounded-sm" />
          <div>
            <h1 className="text-base font-semibold">Claude Bridge</h1>
            <p className="text-[11px] text-muted-foreground">
              {setupMode ? "First-run setup" : "Sign in"}
            </p>
          </div>
        </div>

        {setupMode ? (
          <SetupForm
            onDone={() => window.location.replace(nextDest())}
          />
        ) : pending ? (
          <PendingApprovalNotice
            pendingId={pending.id}
            deviceLabel={pending.deviceLabel}
            expiresAt={pending.expiresAt}
            onCancel={() => {
              setPending(null);
              setError("Login attempt canceled.");
            }}
          />
        ) : (
          <form onSubmit={submit} className="grid gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="login-email">Email</Label>
              <Input
                id="login-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoFocus
                autoComplete="email"
                required
                disabled={submitting}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="login-pass">Password</Label>
              <Input
                id="login-pass"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
                disabled={submitting}
              />
            </div>
            <label className="flex items-center gap-2 text-xs text-muted-foreground select-none cursor-pointer mt-1">
              <input
                type="checkbox"
                checked={trust}
                onChange={(e) => setTrust(e.target.checked)}
                disabled={submitting}
                className="h-3.5 w-3.5 accent-primary"
              />
              <ShieldCheck size={12} className="text-primary" />
              <span>Trust this device for 30 days</span>
            </label>
            {error ? (
              <p className="text-xs text-destructive bg-destructive/10 border border-destructive/30 rounded px-2 py-1.5">
                {error}
              </p>
            ) : null}
            <Button type="submit" disabled={submitting} className="mt-1">
              {submitting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <LogIn className="h-3.5 w-3.5" />
              )}
              {submitting ? "Signing in…" : "Sign in"}
            </Button>
          </form>
        )}
      </div>
      <p className="text-[10px] text-muted-foreground/70 mt-4 text-center max-w-sm">
        Single-user local app. Credentials live in{" "}
        <code className="font-mono">~/.claude/bridge.json</code> outside the
        project tree, so a <code className="font-mono">git pull</code> on the
        bridge repo never touches them.
      </p>
    </div>
  );
}

/**
 * First-run setup form rendered when `auth` isn't yet configured in
 * bridge.json. POSTs to `/api/auth/setup` which:
 *   - requires the one-time setup token printed in the bridge boot
 *     banner (defends against Host-header spoofing on LAN-bound
 *     bridges — see `libs/setupToken.ts`),
 *   - keeps the loopback Host check as defense-in-depth so the LAN
 *     case is awkward even before a token is acquired,
 *   - refuses to overwrite an existing `auth` block (to rotate the
 *     password the operator must run `bun scripts/set-password.ts`),
 *   - hashes the password with scrypt + signs a 30-day cookie so the
 *     post-setup redirect lands already-authenticated.
 */
function SetupForm({ onDone }: { onDone(): void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [setupToken, setSetupToken] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setError(null);
    if (!setupToken.trim()) {
      setError("Setup token is required (see the bridge terminal banner).");
      return;
    }
    if (password !== confirm) {
      setError("Passwords do not match");
      return;
    }
    if (password.length < 12) {
      setError("Password must be at least 12 characters");
      return;
    }
    setSubmitting(true);
    try {
      const r = await fetch("/api/auth/setup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email,
          password,
          confirmPassword: confirm,
          setupToken: setupToken.trim(),
        }),
      });
      if (!r.ok) {
        const text = await r.text();
        try {
          const parsed = JSON.parse(text) as { error?: string; hint?: string };
          setError(
            [parsed.error, parsed.hint].filter(Boolean).join(" — ") ||
            `Setup failed (${r.status})`,
          );
        } catch {
          setError(text || `Setup failed (${r.status})`);
        }
        return;
      }
      onDone();
    } catch (err) {
      setError((err as Error).message || "Network error");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={submit} className="grid gap-3">
      <div className="flex items-start gap-2 rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-[11px] text-foreground">
        <KeyRound className="h-4 w-4 mt-0.5 text-primary shrink-0" />
        <p>
          No credentials set yet. Create the operator account below — this
          is a <strong>one-time</strong> setup. To rotate later you&apos;ll need{" "}
          <code className="font-mono">bun scripts/set-password.ts</code>.
        </p>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="setup-token">Setup token</Label>
        <Input
          id="setup-token"
          type="text"
          value={setupToken}
          onChange={(e) => setSetupToken(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          required
          disabled={submitting}
          placeholder="Paste from the bridge terminal banner"
        />
        <p className="text-[10px] text-muted-foreground">
          Look for{" "}
          <code className="font-mono">[bridge] auth MISSING …</code> in the
          terminal where you ran <code className="font-mono">bun dev</code> /{" "}
          <code className="font-mono">bun start</code>. The token guards
          first-run setup against LAN visitors.
        </p>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="setup-email">Email</Label>
        <Input
          id="setup-email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoFocus
          autoComplete="username"
          required
          disabled={submitting}
        />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="setup-pass">Password</Label>
        <Input
          id="setup-pass"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="new-password"
          minLength={12}
          required
          disabled={submitting}
        />
        <p className="text-[10px] text-muted-foreground">
          Minimum 12 characters. Stored as scrypt hash in{" "}
          <code className="font-mono">~/.claude/bridge.json</code>.
        </p>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="setup-confirm">Confirm password</Label>
        <Input
          id="setup-confirm"
          type="password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          autoComplete="new-password"
          required
          disabled={submitting}
        />
      </div>
      {error ? (
        <p className="text-xs text-destructive bg-destructive/10 border border-destructive/30 rounded px-2 py-1.5">
          {error}
        </p>
      ) : null}
      <Button type="submit" disabled={submitting} className="mt-1">
        {submitting ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <ShieldCheck className="h-3.5 w-3.5" />
        )}
        {submitting ? "Creating account…" : "Create account"}
      </Button>
    </form>
  );
}

/**
 * Rendered while the new device is waiting for an existing trusted
 * device to approve the login request. Shows:
 *   - live countdown until the 3-min approval window expires
 *   - the device label that was registered
 *   - a copyable CLI command (`bun run approve:login <id>`) so the
 *     operator can authorize from a terminal on the bridge host
 *     without needing another browser session
 */
function PendingApprovalNotice({
  pendingId,
  deviceLabel,
  expiresAt,
  onCancel,
}: {
  pendingId: string;
  deviceLabel: string;
  expiresAt: string;
  onCancel(): void;
}) {
  const [secondsLeft, setSecondsLeft] = useState<number>(() =>
    Math.max(0, Math.floor((Date.parse(expiresAt) - Date.now()) / 1000)),
  );
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const handle = setInterval(() => {
      setSecondsLeft((s) => Math.max(0, s - 1));
    }, 1000);
    return () => clearInterval(handle);
  }, []);

  const cliCommand = `bun run approve:login ${pendingId}`;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(cliCommand);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API may be unavailable on http: — fall through, the
      // command stays selectable in the <code> block.
    }
  };

  return (
    <div className="grid gap-3 text-xs text-muted-foreground">
      <div className="flex items-start gap-2 rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-foreground">
        <Loader2 className="h-4 w-4 mt-0.5 text-primary shrink-0 animate-spin" />
        <div>
          <p className="font-medium">Waiting for approval</p>
          <p className="text-[11px] text-muted-foreground mt-1">
            Either tap <strong>Approve</strong> on a signed-in device, OR run
            the CLI below in a terminal on the bridge host.
          </p>
        </div>
      </div>
      <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-[11px] leading-relaxed">
        <div>
          Device: <span className="font-mono text-foreground">{deviceLabel}</span>
        </div>
        <div>
          Expires in:{" "}
          <span className="font-mono text-foreground">
            {Math.floor(secondsLeft / 60)
              .toString()
              .padStart(2, "0")}
            :
            {(secondsLeft % 60).toString().padStart(2, "0")}
          </span>
        </div>
      </div>
      <div className="grid gap-1.5">
        <div className="flex items-center justify-between">
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground/80">
            Approve from terminal
          </span>
          <button
            type="button"
            onClick={copy}
            className="text-[10px] text-primary hover:underline"
          >
            {copied ? "copied" : "copy"}
          </button>
        </div>
        <code className="block w-full rounded border border-border bg-background px-2 py-1.5 font-mono text-[11px] text-foreground break-all select-all">
          {cliCommand}
        </code>
        <p className="text-[10px] text-muted-foreground">
          Add <code className="font-mono">--deny</code> to reject. Reads
          the bypass token from{" "}
          <code className="font-mono">~/.claude/bridge.json</code>.
        </p>
      </div>
      <Button variant="outline" onClick={onCancel}>
        Cancel and try again
      </Button>
    </div>
  );
}

/**
 * Resolve the post-login redirect target. Honors `?next=…` when it's
 * a same-origin path, otherwise falls back to `/`. Prevents open-
 * redirect by rejecting absolute URLs and protocol-relative `//foo`.
 */
function nextDest(): string {
  if (typeof window === "undefined") return "/";
  const sp = new URLSearchParams(window.location.search);
  const raw = sp.get("next");
  if (!raw) return "/";
  if (!raw.startsWith("/") || raw.startsWith("//")) return "/";
  return raw;
}
