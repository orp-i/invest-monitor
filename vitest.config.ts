import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.{ts,mjs}"],
    globalSetup: ["tests/global-setup.ts"],
    environment: "node",
    passWithNoTests: false,
  },
});
