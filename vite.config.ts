import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { createNotebookApiHandler } from "./server/notebook-server.mjs";

export default defineConfig({
  plugins: [react(), {
    name: "notebook-api-boundary",
    configureServer(server) {
      server.middlewares.use(createNotebookApiHandler());
    },
  }],
});
