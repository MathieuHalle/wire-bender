import type { Tag } from './types'

/**
 * The nets a tag stands for: its connectivity group's nets (all of them for a short), else
 * its own net. NC, an empty-string net and part bodies stand for none. The 3D highlight and
 * the page's hover both use this, so they agree.
 */
export function tagNets(tag: Tag | null | undefined): string[] {
  if (!tag) return []
  return (tag.nets ?? (tag.net ? [tag.net] : [])).filter(n => n !== '')
}
