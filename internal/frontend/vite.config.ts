import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import license from "rollup-plugin-license";
import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";

// Resolve the pdfjs-dist worker file through pnpm's strict linking.
function pdfjsWorkerPlugin(): Plugin {
  const require = createRequire(import.meta.url);
  const pdfjsDir = path.dirname(require.resolve("pdfjs-dist/package.json"));
  const workerSrc = path.join(pdfjsDir, "build", "pdf.worker.min.mjs");
  const workerFileName = "pdf.worker.min.mjs";

  return {
    name: "pdfjs-worker",
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: workerFileName,
        source: fs.readFileSync(workerSrc),
      });
    },
    configureServer(server) {
      server.middlewares.use(`/${workerFileName}`, (_req, res) => {
        res.setHeader("Content-Type", "application/javascript");
        fs.createReadStream(workerSrc).pipe(res);
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), pdfjsWorkerPlugin()],
  build: {
    outDir: "../static/dist",
    emptyOutDir: true,
    rollupOptions: {
      plugins: [
        license({
          thirdParty: {
            output: {
              file: path.resolve(__dirname, "CREDITS_FRONTEND"),
              template(dependencies) {
                return dependencies
                  .map(
                    (dep) => {
                      const repo = typeof dep.repository === "string"
                        ? dep.repository
                        : dep.repository?.url || "";
                      const url = repo || dep.homepage || "";
                      return `${dep.name}\n${url}\n----------------------------------------------------------------\n${dep.licenseText || `License: ${dep.license}`}\n`;
                    },
                  )
                  .join(
                    "\n================================================================\n\n",
                  );
              },
            },
          },
        }),
      ],
    },
  },
  server: {
    proxy: {
      "/_/": "http://localhost:6275",
    },
  },
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
    environment: "jsdom",
    setupFiles: ["src/test-setup.ts"],
    coverage: {
      provider: "v8",
      include: ["src/utils/**", "src/hooks/**", "src/components/**", "src/renderers/**"],
      reporter: ["text", "lcov"],
      reportsDirectory: "coverage",
    },
  },
});
