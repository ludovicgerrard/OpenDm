import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// OpenDM desktop UI. Production build is embedded into OpenDM.exe via
// tauri.conf.json → build.frontendDist ("webui/dist").
export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2020",
  },
});
