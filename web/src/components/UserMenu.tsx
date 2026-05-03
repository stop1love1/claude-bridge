// Avatar-style header dropdown for the logged-in operator.
//
// Backend gap: the Go bridge does not yet expose `/api/auth/me`,
// `/api/auth/logout`, or any other `/api/auth/*` surface. The
// Next.js source rendered the operator email + trusted-device label
// + a Sign-out action; here, when the probe of `/api/auth/me` 404s
// (or fails for any reason), we degrade to a minimal "Connected · open
// Settings" entry pointing at the in-app settings page.
//
// TODO: when /api/auth/* lands, wire full UserMenu here — show the
// operator email, trusted-device row, and a real Sign-out action that
// POSTs to /api/auth/logout and hard-redirects to /login.

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Gauge, Settings as SettingsIcon, User as UserIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface MeResponse {
  configured?: boolean;
  user?: { email: string } | null;
  trustedDevice?: { id: string; label: string | null; expiresAt: string } | null;
  expiresAt?: string;
}

type ProbeState =
  | { kind: "loading" }
  | { kind: "configured"; me: MeResponse }
  | { kind: "degraded" }; // /api/auth/me missing or returned !ok

export function UserMenu() {
  const [state, setState] = useState<ProbeState>({ kind: "loading" });

  useEffect(() => {
    const ac = new AbortController();
    void (async () => {
      try {
        const r = await fetch("/api/auth/me", {
          cache: "no-store",
          signal: ac.signal,
        });
        if (!r.ok) {
          if (!ac.signal.aborted) setState({ kind: "degraded" });
          return;
        }
        const data = (await r.json()) as MeResponse;
        if (ac.signal.aborted) return;
        if (data.configured && data.user) {
          setState({ kind: "configured", me: data });
        } else {
          setState({ kind: "degraded" });
        }
      } catch {
        // Abort or network error — fall back to the degraded link.
        if (!ac.signal.aborted) setState({ kind: "degraded" });
      }
    })();
    return () => ac.abort();
  }, []);

  if (state.kind === "loading") return null;

  // Degraded path: no auth backend wired. Render the dropdown but
  // surface a Settings link instead of email + Sign-out.
  if (state.kind === "degraded") {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="iconSm"
            aria-label="Account menu"
            title="Token-only auth. Open Settings to manage."
            className="text-fg-dim hover:text-foreground"
          >
            <UserIcon size={14} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuLabel>Account</DropdownMenuLabel>
          <div className="px-2 pb-1.5 text-xs">
            Connected · open Settings
          </div>
          <DropdownMenuSeparator />
          <DropdownMenuItem asChild>
            <Link to="/settings" className="cursor-pointer">
              <SettingsIcon size={12} />
              <span>Settings</span>
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link to="/usage" className="cursor-pointer">
              <Gauge size={12} />
              <span>Usage</span>
            </Link>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  // Full path — kept structurally close to the Next.js original so it
  // is trivial to re-enable once /api/auth/me lands. This branch is
  // dead today but lights up automatically the moment the endpoint
  // returns `configured: true`.
  const { me } = state;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="iconSm"
          aria-label="Account menu"
          title={me.user?.email}
          className="text-fg-dim hover:text-foreground"
        >
          <UserIcon size={14} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>Signed in as</DropdownMenuLabel>
        <div className="px-2 pb-1.5 text-xs font-medium">
          {me.user?.email}
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to="/usage" className="cursor-pointer">
            <Gauge size={12} />
            <span>Usage</span>
          </Link>
        </DropdownMenuItem>
        {/* TODO: when /api/auth/logout lands, restore the Sign-out item here. */}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
