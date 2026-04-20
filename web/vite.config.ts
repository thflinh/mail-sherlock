import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/** Dev proxy: long LLM + Gmail sync can exceed Node's default ~2m timeout → 504 for unrelated routes. */
const BACKEND_TARGET = "http://localhost:8000";
const PROXY_TIMEOUT_MS = 300_000;

const backendProxy = {
  target: BACKEND_TARGET,
  changeOrigin: true,
  timeout: PROXY_TIMEOUT_MS,
  proxyTimeout: PROXY_TIMEOUT_MS,
};

export default defineConfig({
  base: "/",
  plugins: [react()],
  server: {
    proxy: {
      "/ask": backendProxy,
      "/chat": backendProxy,
      "/auth": backendProxy,
      "/emails": backendProxy,
      "/email": backendProxy,
      "/accounts": backendProxy,
      "/connect": backendProxy,
      "/oauth": backendProxy,
      "/status": backendProxy,
      "/health": backendProxy,
      "/ready": backendProxy,
    },
  },
  build: {
    outDir: "../backend/static",
    emptyOutDir: true,
  },
});
