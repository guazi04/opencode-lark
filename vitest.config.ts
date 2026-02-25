import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "node",
    root: "src",
    include: ["**/*.test.ts"],
    globals: true,
  },
})
