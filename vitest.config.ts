import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// `vue` is a dependency of nuxt, not hoisted by pnpm; resolve it the way the app does.
const fromNuxt = createRequire(fileURLToPath(new URL('./node_modules/nuxt/package.json', import.meta.url)))

export default defineConfig({
  resolve: {
    alias: {
      '~core': fileURLToPath(new URL('./core', import.meta.url)),
      '#shared': fileURLToPath(new URL('./shared', import.meta.url)),
      'vue': path.dirname(fromNuxt.resolve('vue/package.json'))
    }
  },
  test: {
    include: ['tests/**/*.test.ts']
  }
})
