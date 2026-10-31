/** Zaubersprüche aller Lores (spells.json), einmal geladen und nach slug abrufbar */
export interface SpellInfo { name: string; slug: string; type: string; castingValue: number | null; range: string; text: string; lore: string }

const bySlug = new Map<string, SpellInfo>();
let loading: Promise<void> | null = null;

/** spells.json laden (einmal); danach liefert spellInfo die Sprüche */
export function loadSpells(): Promise<void> {
  loading ??= fetch(`${import.meta.env.BASE_URL}data/spells.json`).then((r) => (r.ok ? r.json() : [])).catch(() => [])
    .then((lores: { name: string; spells: Omit<SpellInfo, 'lore'>[] }[]) => {
      for (const l of lores) for (const s of l.spells) bySlug.set(s.slug, { ...s, lore: l.name });
    });
  return loading;
}

export const spellInfo = (slug: string) => bySlug.get(slug);
