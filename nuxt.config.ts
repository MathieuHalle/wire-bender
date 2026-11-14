import { fileURLToPath } from 'node:url'
import tres from '@tresjs/core/template-compiler-options'
import { uiTheme } from './app/uiTheme'
// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  modules: [
    '@nuxt/eslint',
    '@nuxt/ui',
    'nuxt-auth-utils'
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

  // The Nuxt UI theme (colors, icons), from app/uiTheme.ts.
  appConfig: {
    ui: uiTheme
  },

  runtimeConfig: {
    session: {
      maxAge: 60 * 60 * 24 * 30
    }
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

  // Sign-in (public mode). The app reads who is signed in from GET /api/me, not from the
  // module's session composable. The session secret is set at start (server/plugins/startup.ts).
  auth: {
    loadStrategy: 'none'
  },

  eslint: {
    config: {
      stylistic: {
        commaDangle: 'never',
        braceStyle: '1tbs'
      }
    }
  },

  // Nuxt UI client-bundles only icons from the collections its defaults use (Lucide), so the
  // theme's Material Symbols are listed here: they ship with the page instead of being fetched
  // one by one from /api/_nuxt_icon.
  icon: {
    clientBundle: {
      icons: Object.values(uiTheme.icons).map(name => name.replace(/^i-material-symbols-/, 'material-symbols:'))
    }
  }
})
