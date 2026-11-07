import { fileURLToPath } from 'node:url'
import tres from '@tresjs/core/template-compiler-options'
// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  modules: [
    '@nuxt/eslint',
    '@nuxt/ui'
  ],

  devtools: {
    enabled: true
  },

  app: {
    head: {
      title: 'WireBender',
      link: [
        { rel: 'icon', type: 'image/svg+xml', href: '/icon.svg' }
      ]
    }
  },

  css: ['~/assets/css/main.css'],

  // TresJS elements (<TresMesh>, <primitive>) belong to its own renderer, not to Vue's.
  vue: {
    compilerOptions: tres.template.compilerOptions
  },

  alias: {
    '~core': fileURLToPath(new URL('./core', import.meta.url))
  },

  compatibilityDate: '2026-06-30',

  // Live boards speak the y-websocket protocol on /_ws/board/<id>.
  nitro: {
    experimental: {
      websocket: true
    }
  },

  // `pnpm dev` listens on the network (--host) and Vite serves project files under
  // /_nuxt/ before the access check runs: never the data folder or a database.
  vite: {
    server: {
      fs: {
        deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/.data/**', '**/*.sqlite', '**/*.sqlite-*', '**/backups/**']
      }
    }
  },

  // export/ is not imported by the app; include it so `nuxt typecheck` covers it.
  typescript: {
    tsConfig: {
      include: ['../export/**/*']
    }
  },

  eslint: {
    config: {
      stylistic: {
        commaDangle: 'never',
        braceStyle: '1tbs'
      }
    }
  }
})
