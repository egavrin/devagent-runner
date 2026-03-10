import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@devagent-runner/adapters": fileURLToPath(new URL("./packages/adapters/src/index.ts", import.meta.url)),
      "@devagent-runner/cli": fileURLToPath(new URL("./packages/cli/src/index.ts", import.meta.url)),
      "@devagent-runner/core": fileURLToPath(new URL("./packages/core/src/index.ts", import.meta.url)),
      "@devagent-runner/local-runner": fileURLToPath(new URL("./packages/local-runner/src/index.ts", import.meta.url)),
      "@devagent-sdk/schema": fileURLToPath(new URL("../devagent-sdk/packages/schema/src/index.ts", import.meta.url)),
      "@devagent-sdk/types": fileURLToPath(new URL("../devagent-sdk/packages/types/src/index.ts", import.meta.url)),
      "@devagent-sdk/validation": fileURLToPath(new URL("../devagent-sdk/packages/validation/src/index.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["packages/*/src/**/*.test.ts"],
  },
});
