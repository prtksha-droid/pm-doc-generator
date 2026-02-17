import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/fully-automate": {
        target: "http://localhost:3000",
        changeOrigin: true,
      },
      "/ai-draft": {
        target: "http://localhost:3000",
        changeOrigin: true,
      },
      "/generate-docx": {
        target: "http://localhost:3000",
        changeOrigin: true,
      },
    },
  },
});
