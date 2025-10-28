import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { FlatCompat } from "@eslint/eslintrc";
import tseslint from "typescript-eslint";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

export default tseslint.config(
  // Next.js rules via compat
  ...compat.extends("next/core-web-vitals"),
  // TypeScript ESLint recommended (no type-checking required)
  ...tseslint.configs.recommended,
  // Ensure TypeScript parser resolves the correct tsconfig root
  {
    languageOptions: {
      parserOptions: {
        tsconfigRootDir: __dirname,
      },
    },
  },
  // Ignores
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "out/**",
      "build/**",
      "next-env.d.ts",
      "scripts/pr-review/pr-review-inject.bundle.js",
    ],
  },
  // Project rules
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      // Disable base rule to avoid duplicate reporting
      "no-unused-vars": "off",
    },
  }
);
