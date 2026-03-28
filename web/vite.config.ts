import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "/",
  plugins: [react()],
  server: {
    proxy: {
      "/ask":        "http://localhost:8000",
      "/auth":       "http://localhost:8000",
      "/health":     "http://localhost:8000",
      "/ready":      "http://localhost:8000",
    },
  },
  build: {
    outDir: "../backend/static",
    emptyOutDir: true,
  },
});
