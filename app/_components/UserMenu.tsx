"use client";

import { useEffect, useState } from "react";
import { LogOut, ShieldCheck, User as UserIcon } from "lucide-react";
import { Button } from "./ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";

interface MeResponse {
  configured?: boolean;
  user?: { email: string } | null;
  trustedDevice?: { id: string; label: string | null; expiresAt: string } | null;
  expiresAt?: string;
}

/**
 * Avatar-style header dropdown for the logged-in operator. Shows the
 * username + (when applicable) the trusted-device label, with a logout
 * action. Renders nothing when auth isn't configured (first-run install)
 * so the header doesn't show a stray icon during setup.
 */
export function UserMenu() {
  const [me, setMe] = useState<MeResponse | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch("/api/auth/me", { cache: "no-store" });
        if (!r.ok) return;
        const data = (await r.json()) as MeResponse;
        if (!cancelled) setMe(data);
      } catch { /* leave me === null, the menu hides */ }
    })();
    return () => { cancelled = true; };
  }, []);

  const logout = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      // Hard reload to /login — middleware will redirect once the
      // cookie is gone, but going there directly avoids a flash of
      // dashboard content first.
      window.location.replace("/login");
    }
  };

  if (!me?.configured || !me.user) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="iconSm"
          aria-label="Account menu"
          title={me.user.email}
          className="text-fg-dim hover:text-foreground"
        >
          <UserIcon size={14} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>Signed in as</DropdownMenuLabel>
        <div className="px-2 pb-1.5 text-xs font-medium">{me.user.email}</div>
        {me.trustedDevice ? (
          <>
            <DropdownMenuSeparator />
            <div className="px-2 py-1.5 text-[11px] text-muted-foreground flex items-start gap-1.5">
              <ShieldCheck size={11} className="mt-0.5 text-primary shrink-0" />
              <div className="min-w-0">
                <div className="truncate text-foreground">
                  {me.trustedDevice.label ?? "Trusted device"}
                </div>
                <div>
                  Expires {new Date(me.trustedDevice.expiresAt).toLocaleDateString()}
                </div>
              </div>
            </div>
          </>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={logout}
          disabled={busy}
          className="text-destructive focus:text-destructive"
        >
          <LogOut size={12} />
          <span>Sign out</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
