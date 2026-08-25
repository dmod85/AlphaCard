/**
 * eBay's catalog title-cases some all-caps acronyms in item specifics
 * (e.g. Set = "… Fifa World Cup" or "… Mls"). Listing titles keep the
 * canonical all-caps form so Title Check doesn't flag FIFA → Fifa /
 * MLS → Mls, and so applying a template always writes FIFA / MLS.
 */
const TITLE_ACRONYMS = ['FIFA', 'MLS'] as const;

export function canonicalizeTitleAcronyms(title: string): string {
    let out = title;
    for (const acronym of TITLE_ACRONYMS) {
        out = out.replace(new RegExp(`\\b${acronym}\\b`, 'gi'), acronym);
    }
    return out;
}
