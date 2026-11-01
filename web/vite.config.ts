import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const projectsDir = process.env.VE_PROJECTS_DIR ?? join(__dirname, "..", "projects");
const tokenPath = join(projectsDir, ".mcp-token");
const token = process.env.VE_MCP_TOKEN ?? (existsSync(tokenPath) ? readFileSync(tokenPath, "utf8").trim() : "");

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // The dev server stands in for the browser's cookie and same-origin request.
      "/api": {
        target: `http://127.0.0.1:${process.env.VE_MCP_PORT ?? 8765}`,
        changeOrigin: true,
        ws: true,
        headers: { authorization: `Bearer ${token}` },
        configure: (proxy) => {
          proxy.on("proxyReq", (request) => request.removeHeader("origin"));
          proxy.on("proxyReqWs", (request) => request.removeHeader("origin"));
        },
      },
    },
  },
});
