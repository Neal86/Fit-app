export type IdentityOptions = { reserved?: unknown; makeId?: () => string }

/** Collect identity definitions and references, including archived and active snapshots. */
export function freshIdentityFactory(reserved: unknown, makeId: () => string): () => string {
  const identities = new Set<string>()
  const seen = new WeakSet<object>()
  const collect = (value: unknown): void => {
    if (!value || typeof value !== 'object' || seen.has(value)) return
    seen.add(value)
    if (Array.isArray(value)) { value.forEach(collect); return }
    for (const [key, child] of Object.entries(value)) {
      if ((key === 'id' || key.endsWith('Id')) && typeof child === 'string') identities.add(child)
      else if (key.endsWith('Ids') && Array.isArray(child)) child.forEach(id => { if (typeof id === 'string') identities.add(id) })
      else collect(child)
    }
  }
  collect(reserved)
  return () => {
    for (let attempt = 0; attempt < 20; attempt++) {
      const id = makeId()
      if (typeof id === 'string' && id.trim() && id.length <= 150 && !identities.has(id)) { identities.add(id); return id }
    }
    throw new Error('Could not create distinct identities. No data was changed; try again.')
  }
}
