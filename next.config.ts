import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Disable double-render in dev: keystrokes in the composer were
  // re-running effects twice per tick, piling up with the tail poll.
  // Still opt back in when debugging effect cleanup.
  reactStrictMode: false,
  allowedDevOrigins: process.env.ALLOWED_DEV_ORIGINS?.split(",") || [],
};

export default nextConfig;
