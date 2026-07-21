import { defineConfig, globalIgnores } from "eslint/config"
import nextCoreWebVitals from "eslint-config-next/core-web-vitals"
import nextTypeScript from "eslint-config-next/typescript"

export default defineConfig([
  ...nextCoreWebVitals,
  ...nextTypeScript,
  {
    files: ["app/dashboard/**"],
    // Dashboard is legacy client code. React Compiler migration is tracked
    // separately; keep these exceptions confined to that boundary.
    rules: {
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/static-components": "off",
      "react-hooks/purity": "off",
    },
  },
  {
    files: ["app/layout.{js,jsx,ts,tsx}"],
    rules: { "@next/next/no-page-custom-font": "off" },
  },
  {
    files: ["tests/**", "**/*.test.{js,jsx,ts,tsx}", "**/*.spec.{js,jsx,ts,tsx}", "types/**"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
  {
    // Pre-existing untyped integration boundaries; do not hide new `any` use.
    files: ["app/dashboard/login/page.tsx", "app/v1/send/route.ts", "lib/api-response.ts", "lib/core/aws-utils.ts", "lib/core/common.ts", "lib/core/event-processor.ts", "lib/task-queue/queue.ts", "server.ts", "service/error-handler/error-handler.ts", "service/validation-service/validation.ts"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
  globalIgnores([
    ".next/**",
    "dist/**",
    "coverage/**",
    "lib/generated/**",
    "prisma/generated/**",
  ]),
])
