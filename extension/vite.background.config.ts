import { defineConfig } from "vite";
import { resolve } from "path";

/** Single-file MV3 service worker (no shared chunks). */
export default defineConfig({
  base: "./",
  build: {
    outDir: "../dist",
    emptyOutDir: false,
    rollupOptions: {
      input: resolve(__dirname, "src/background/background.ts"),
      output: {
        entryFileNames: "assets/background.js",
        inlineDynamicImports: true,
        format: "es",
      },
    },
  },
});
