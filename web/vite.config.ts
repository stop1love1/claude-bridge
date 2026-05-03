import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

// Vite is configured to proxy /api to the local Go bridge so that dev
// mode mirrors the prod single-origin embed. Override BRIDGE_DEV_URL if
// the operator runs the backend on a non-default port.
const BRIDGE_DEV_URL = process.env.BRIDGE_DEV_URL ?? "http://localhost:7777";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: BRIDGE_DEV_URL,
        changeOrigin: true,
        ws: true,
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
    target: "es2022",
  },
});
