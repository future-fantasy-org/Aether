import { defineConfig } from "vite";

// Main process build — bundle workspace deps, keep node builtins external.
export default defineConfig({
  build: {
    rollupOptions: {
      external: ["electron"],
    },
  },
  resolve: {
    // Bundle @aether/* source directly in dev for fast iteration.
    alias: {},
  },
});
