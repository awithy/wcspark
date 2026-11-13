import type { ReactNode } from "react";

const URL_SOURCE = String.raw`\bhttps?:\/\/[^\s<>"]+`;
const URL_RE = new RegExp(URL_SOURCE, "gi");
/** Inline `code` (single line) or a URL. Code wins, so URLs inside backticks stay literal. */
const TOKEN_RE = new RegExp(`\`([^\`\\n]+)\`|(${URL_SOURCE})`, "gi");

/** Trims trailing punctuation that's almost certainly not part of the URL. */
function trimUrl(url: string): string {
  let u = url.replace(/[.,;:!?'"*]+$/, "");
  // Keep a trailing ")" only if it closes a "(" inside the URL (e.g. Wikipedia links).
  while (u.endsWith(")") && (u.match(/\(/g)?.length ?? 0) < (u.match(/\)/g)?.length ?? 0)) {
    u = u.slice(0, -1).replace(/[.,;:!?'"*]+$/, "");
  }
  return u;
}

/** The first link in a blurb, if any (used by the `o` shortcut). */
export function firstUrl(text: string | null): string | null {
  if (!text) return null;
  for (const m of text.matchAll(URL_RE)) {
    const before = text.slice(0, m.index);
    // Skip URLs sitting inside an inline code span.
    if ((before.split("\n").pop()!.match(/`/g)?.length ?? 0) % 2 === 1) continue;
    return trimUrl(m[0]);
  }
  return null;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function highlight(text: string, re: RegExp | null, key: string): ReactNode[] {
  if (!re) return [text];
  return text.split(re).map((part, i) => (i % 2 === 1 ? <mark key={`${key}-${i}`}>{part}</mark> : part));
}

/** Splits a URL into a de-emphasised scheme, the host, and a de-emphasised remainder. */
function UrlText({ url, re, k }: { url: string; re: RegExp | null; k: string }) {
  const m = /^(https?:\/\/)([^/?#]+)(.*)$/i.exec(url);
  // A search term spanning the parts would be split apart, so highlight the URL as a whole instead.
  if (!m || (re && url.split(re).length > 1)) return <>{highlight(url, re, k)}</>;
  return (
    <>
      <span className="url-scheme">{m[1]}</span>
      <span className="url-host">{m[2]}</span>
      {m[3] && <span className="url-rest">{m[3]}</span>}
    </>
  );
}

/** Plain text with clickable URLs, inline `code`, and optional highlighted search terms. */
export function RichText({ text, terms = [] }: { text: string; terms?: string[] }) {
  const re = terms.length
    ? new RegExp(`(${[...terms].sort((a, b) => b.length - a.length).map(escapeRe).join("|")})`, "gi")
    : null;
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  for (const m of text.matchAll(TOKEN_RE)) {
    const start = m.index;
    if (m[1] !== undefined) {
      out.push(...highlight(text.slice(last, start), re, `t${n++}`));
      out.push(<code key={`c${n++}`}>{highlight(m[1], re, `c${n}`)}</code>);
      last = start + m[0].length;
    } else {
      const url = trimUrl(m[0]);
      out.push(...highlight(text.slice(last, start), re, `t${n++}`));
      out.push(
        <a key={`u${n++}`} href={url} target="_blank" rel="noopener noreferrer">
          <UrlText url={url} re={re} k={`u${n}`} />
        </a>,
      );
      last = start + url.length;
    }
  }
  out.push(...highlight(text.slice(last), re, `t${n++}`));
  return <>{out}</>;
}
