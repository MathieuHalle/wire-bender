import { fileURLToPath } from 'node:url'
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

  alias: {
    '~core': fileURLToPath(new URL('./core', import.meta.url))
  },

  compatibilityDate: '2026-06-30',

  eslint: {
    config: {
      stylistic: {
        commaDangle: 'never',
        braceStyle: '1tbs'
      }
    }
  }
})
