import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";

// The React review page. "npm run dev" runs it on :5173 with live reload; "npm run build" puts it in dist/
// (in Docker, nginx serves dist/ and forwards /api to the API: see nginx.conf.template).
const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig(({ mode }) => {
  // The page calls /api on its own address; the dev server forwards it to the API.
  // API_URL from .env (a value set in the shell wins); http://localhost:3000 when missing or blank.
  const apiUrl = loadEnv(mode, root, "").API_URL?.trim() || "http://localhost:3000";
  return {
    root,
    plugins: [react()],
    build: { outDir: "dist", emptyOutDir: true },
    server: {
      port: 5173,
      strictPort: true,
      // changeOrigin: the API checks that requests are addressed to it (see the API's main.ts).
      proxy: { "/api": { target: apiUrl, changeOrigin: true } },
    },
  };
});
