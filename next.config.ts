import type { NextConfig } from "next";

/**
 * Security headers applied to every response. We attach them via the
 * Next `headers()` config rather than middleware so static asset and
 * Next-internal routes get them too.
 *
 * - HSTS only emits in production behind TLS (`NODE_ENV === "production"`)
 *   so dev's plain-HTTP listener doesn't get pinned to HTTPS.
 * - The CSP is intentionally loose around `'unsafe-inline'` /
 *   `'unsafe-eval'` because Next dev + the existing Tailwind/Antd
 *   pipeline rely on inline styles. Tightening further requires a
 *   nonce-aware build pipeline, which is a bigger refactor.
 * - `frame-ancestors 'none'` + the explicit `X-Frame-Options: DENY`
 *   give us double-coverage for click-jacking. They're redundant by
 *   spec but some legacy proxies strip the CSP variant.
 */
const isProd = process.env.NODE_ENV === "production";

const baseHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Cross-origin isolation light: keep window-level isolation enabled
  // so a hostile cross-origin window can't read into ours.
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  // Block legacy permissions APIs we don't use; trim the surface area
  // of "browser fingerprinting" / device-access vectors a hijacked
  // session would otherwise have access to.
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=()",
  },
  {
    key: "Content-Security-Policy",
    // `frame-ancestors 'none'` for click-jacking; `connect-src 'self'`
    // limits the bridge UI to talking to its own origin (Telegram /
    // Claude API hits go through the server, never directly from the
    // browser). `base-uri 'self'` blocks `<base href>` injection.
    value: [
      "default-src 'self'",
      "img-src 'self' data: blob:",
      "media-src 'self' blob:",
      "font-src 'self' data:",
      // Inline styles are required by Tailwind/Antd; same trade-off as
      // the rest of the Next.js ecosystem.
      "style-src 'self' 'unsafe-inline'",
      // Inline + eval scripts are required by the Next dev runtime;
      // production builds emit hashed scripts, but disabling
      // 'unsafe-inline' still breaks Antd's runtime style injection.
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "object-src 'none'",
    ].join("; "),
  },
] as const;

const prodOnlyHeaders = isProd
  ? [
      // Pin TLS for two years on every sub-domain. Operator must serve
      // every host they actually use over HTTPS or the bridge becomes
      // unreachable from already-pinned browsers — that's the point.
      {
        key: "Strict-Transport-Security",
        value: "max-age=63072000; includeSubDomains; preload",
      },
    ]
  : [];

const nextConfig: NextConfig = {
  // Disable double-render in dev: keystrokes in the composer were
  // re-running effects twice per tick, piling up with the tail poll.
  // Still opt back in when debugging effect cleanup.
  reactStrictMode: false,
  allowedDevOrigins: process.env.ALLOWED_DEV_ORIGINS?.split(",") || [],
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [...baseHeaders, ...prodOnlyHeaders],
      },
    ];
  },
};

export default nextConfig;
