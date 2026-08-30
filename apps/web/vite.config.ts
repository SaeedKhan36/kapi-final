import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const plane = process.env.CONTROL_PLANE_URL ?? "http://localhost:8787";

export default defineConfig({
  // tsconfig `paths` only informs the type checker; Vite needs its own alias.
  resolve: {
    alias: { "~": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: {
    port: 3000,
    proxy: {
      // Keeps the browser same-origin, so no CORS and no env juggling in dev -
      // and the websocket inherits the page's own host, which is what makes
      // `new WebSocket(location.host)` work unchanged in dev and behind a proxy.
      "/api": { target: plane, changeOrigin: true },
      "/ws": { target: plane.replace(/^http/, "ws"), ws: true },
    },
  },
  plugins: [tailwindcss(), viteReact()],
});
