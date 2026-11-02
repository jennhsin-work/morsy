import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      // The agent backend holds the Anthropic key; the browser never sees it.
      "/api": "http://localhost:8787",
    },
  },
  worker: { format: "es" },
});
