/**
 * eBay's catalog title-cases some all-caps acronyms in item specifics
 * (e.g. Set = "2026 Panini Prizm Monopoly Fifa World Cup"). Listing titles
 * should keep the canonical all-caps form so Title Check doesn't flag
 * FIFA → Fifa, and so applying a template always writes FIFA.
 */
const TITLE_ACRONYMS = ['FIFA'] as const;

export function canonicalizeTitleAcronyms(title: string): string {
    let out = title;
    for (const acronym of TITLE_ACRONYMS) {
        out = out.replace(new RegExp(`\\b${acronym}\\b`, 'gi'), acronym);
    }
    return out;
}
