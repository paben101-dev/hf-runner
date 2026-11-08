import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  resolve: { alias: { '@shared': resolve(__dirname, 'src/shared') } },
  test: { include: ['tests/**/*.test.{ts,tsx}'], testTimeout: 30_000 },
})
