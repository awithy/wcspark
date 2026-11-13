import { Fragment, type ReactNode } from "react";

const URL_RE = /\bhttps?:\/\/[^\s<>"]+/gi;

/** Trims trailing punctuation that's almost certainly not part of the URL. */
function trimUrl(url: string): string {
  let u = url.replace(/[.,;:!?'"*]+$/, "");
  // Keep a trailing ")" only if it closes a "(" inside the URL (e.g. Wikipedia links).
  while (u.endsWith(")") && (u.match(/\(/g)?.length ?? 0) < (u.match(/\)/g)?.length ?? 0)) {
    u = u.slice(0, -1).replace(/[.,;:!?'"*]+$/, "");
  }
  return u;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function highlight(text: string, re: RegExp | null, keyPrefix: string): ReactNode[] {
  if (!re) return [text];
  return text.split(re).map((part, i) =>
    i % 2 === 1 ? <mark key={`${keyPrefix}-${i}`}>{part}</mark> : part,
  );
}

/** Plain text with clickable URLs and optional highlighted search terms. */
export function RichText({ text, terms = [] }: { text: string; terms?: string[] }) {
  const re = terms.length
    ? new RegExp(`(${[...terms].sort((a, b) => b.length - a.length).map(escapeRe).join("|")})`, "gi")
    : null;
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  for (const m of text.matchAll(URL_RE)) {
    const url = trimUrl(m[0]);
    const start = m.index;
    out.push(<Fragment key={n++}>{highlight(text.slice(last, start), re, `t${n}`)}</Fragment>);
    out.push(
      <a key={n++} href={url} target="_blank" rel="noopener noreferrer">
        {highlight(url, re, `u${n}`)}
      </a>,
    );
    last = start + url.length;
  }
  out.push(<Fragment key={n++}>{highlight(text.slice(last), re, `t${n}`)}</Fragment>);
  return <>{out}</>;
}
