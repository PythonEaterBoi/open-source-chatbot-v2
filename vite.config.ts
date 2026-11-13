import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Express mounts Vite in middleware mode in dev, then serves dist/ in prod.
  server: {
    host: "0.0.0.0",
    allowedHosts: true,
    strictPort: false,
  },
  build: {
    outDir: "dist",
    sourcemap: false,
    // Split the markdown/highlighting stack out of the app chunk so first
    // paint isn't blocked by a syntax highlighter.
    rollupOptions: {
      output: {
        manualChunks: {
          markdown: ["react-markdown", "remark-gfm", "rehype-highlight", "lowlight"],
          vendor: ["react", "react-dom"],
        },
      },
    },
  },
});
