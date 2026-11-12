// After a redeploy, an open page can ask for code files the new build no longer has (a
// lazy part such as the 3D view, or a page's chunk). Instead of a cryptic failure, a toast
// says WireBender was updated and offers a reload. Once per page load. Page navigations
// still reload on their own (Nuxt's default); this covers the rest.
import { UPDATED } from '~/utils/staleBuild'

export default defineNuxtPlugin((nuxtApp) => {
  let shown = false
  nuxtApp.hook('app:chunkError', () => {
    if (shown) return
    shown = true
    useToast().add({
      ...UPDATED,
      color: 'info',
      icon: 'i-lucide-refresh-cw',
      duration: 0,
      actions: [{ label: 'Reload', icon: 'i-lucide-refresh-cw', onClick: () => window.location.reload() }]
    })
  })
})
