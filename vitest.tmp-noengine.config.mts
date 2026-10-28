import { defineConfig } from "vitest/config";

export default defineConfig({ test: { environment: "node", include: ["test/factory-workflows.test.ts"] } });
