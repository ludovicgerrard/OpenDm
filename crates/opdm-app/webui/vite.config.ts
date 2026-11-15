import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";

// OpenDM desktop UI (Tauri v2). Production build is embedded into OpenDM.exe via
// tauri.conf.json → build.frontendDist ("webui/dist"); `npm run dev` previews in
// a browser with mock data (docs/MIGRATE_TO_NEW_FRONTEND.md).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: { port: 1420, strictPort: true },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2020",
  },
});
