import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";

/** Single-file Gmail content script (no shared chunks — manifest must load one script). */
export default defineConfig({
  base: "./",
  plugins: [react()],
  build: {
    outDir: "../dist",
    emptyOutDir: false,
    rollupOptions: {
      input: resolve(__dirname, "src/content/content.tsx"),
      output: {
        entryFileNames: "assets/content.js",
        inlineDynamicImports: true,
        format: "es",
      },
    },
  },
});
