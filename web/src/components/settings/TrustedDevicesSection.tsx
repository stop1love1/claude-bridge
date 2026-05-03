import { ShieldCheck } from "lucide-react";

/**
 * Stub of main's TrustedDevicesSection. The Go bridge doesn't expose
 * `/api/auth/devices` yet, and the SPA still authenticates via the
 * pasted bridge token (see AuthSection in Settings.tsx). When the
 * cookie / device flow lands, swap this body for the real list +
 * revoke buttons from main lines 864-989.
 */
export function TrustedDevicesSection() {
  return (
    <section className="rounded-sm border border-border bg-card p-5">
      <div className="mb-1 flex items-center gap-2">
        <ShieldCheck size={14} className="text-primary" />
        <h2 className="font-mono text-small uppercase tracking-wideish text-foreground">
          trusted devices
        </h2>
      </div>
      <p className="mb-3 text-small text-muted-foreground">
        browsers where you ticked &ldquo;trust this device&rdquo; at sign-in.
        each entry holds a 30-day session cookie. revoke any you don&apos;t
        recognize.
      </p>
      <div className="rounded-sm border border-dashed border-border bg-background/50 px-3 py-2 font-mono text-micro text-muted-foreground">
        no trusted devices yet — auth flow not yet ported. use the bridge
        token via the auth section above.
      </div>
    </section>
  );
}
