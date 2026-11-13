/** Splits a search query into terms; "double quoted" phrases are kept together. */
export function parseQuery(q: string): string[] {
  const terms: string[] = [];
  for (const m of q.matchAll(/"([^"]*)"|(\S+)/g)) {
    const term = (m[1] ?? m[2] ?? "").trim();
    if (term) terms.push(term);
  }
  return terms.slice(0, 16);
}
