import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import { Composer, type ComposerInitial } from "./Composer";
import { dayKey, dayLabel } from "./format";
import { Lightbox } from "./Lightbox";
import { SparkCard } from "./SparkCard";
import { parseQuery } from "../shared/query";
import type { Spark, SparkImage } from "../shared/types";

/** Reads content handed over by the PWA share target (see POST /share) from the URL fragment. */
function takeSharedDraft(): ComposerInitial | null {
  const params = new URLSearchParams(window.location.hash.slice(1));
  if (!params.has("share")) return null;
  history.replaceState(null, "", window.location.pathname + window.location.search);
  return {
    blurb: params.get("text"),
    imageIds: params.get("images")?.split(",").filter(Boolean) ?? [],
  };
}

// Read once at module load (not in a state initializer, which StrictMode runs twice).
const sharedDraft = takeSharedDraft();

const initialQuery = () => new URLSearchParams(window.location.search).get("q") ?? "";

export function App() {
  const [input, setInput] = useState(initialQuery);
  const [query, setQuery] = useState(initialQuery);
  const [sparks, setSparks] = useState<Spark[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<{ images: SparkImage[]; index: number } | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  // Debounce the search box into `query`, and mirror it in the URL.
  useEffect(() => {
    const t = setTimeout(() => setQuery(input.trim()), 250);
    return () => clearTimeout(t);
  }, [input]);

  useEffect(() => {
    const url = new URL(window.location.href);
    if (query) url.searchParams.set("q", query);
    else url.searchParams.delete("q");
    history.replaceState(null, "", url);
  }, [query]);

  const load = useCallback(async (q: string, after: string | null) => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setLoading(true);
    setError(null);
    try {
      const page = await api.list({ q, cursor: after }, controller.signal);
      setSparks((prev) => (after ? [...prev, ...page.sparks] : page.sparks));
      setCursor(page.nextCursor);
    } catch (err) {
      if (!controller.signal.aborted) setError((err as Error).message);
    } finally {
      if (requestRef.current === controller) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(query, null);
  }, [query, load]);

  const loadMore = useCallback(() => {
    if (cursor && !loading) void load(query, cursor);
  }, [cursor, loading, load, query]);

  // Infinite scroll: fetch the next page when the sentinel nears the viewport.
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !cursor) return;
    const observer = new IntersectionObserver((entries) => entries[0]?.isIntersecting && loadMore(), {
      rootMargin: "800px",
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [cursor, loadMore]);

  const terms = useMemo(() => parseQuery(query), [query]);

  const groups = useMemo(() => {
    const out: { key: string; label: string; sparks: Spark[] }[] = [];
    for (const s of sparks) {
      const key = dayKey(s.createdAt);
      const last = out[out.length - 1];
      if (last?.key === key) last.sparks.push(s);
      else out.push({ key, label: dayLabel(s.createdAt), sparks: [s] });
    }
    return out;
  }, [sparks]);

  const searching = query.length > 0;

  return (
    <div className="app">
      <header className="topbar">
        <a
          className="brand"
          href="/"
          onClick={(e) => {
            e.preventDefault();
            setInput("");
            window.scrollTo({ top: 0 });
          }}
        >
          <span className="brand-mark" aria-hidden="true">
            ✦
          </span>
          Sparks
        </a>
        <div className="search">
          <input
            type="search"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setInput("")}
            placeholder="Search"
            aria-label="Search sparks"
          />
        </div>
      </header>

      <main>
        {/* Kept mounted while searching so an in-progress draft isn't lost. */}
        <div hidden={searching}>
          <Composer
            initial={sharedDraft ?? undefined}
            autoFocus={!!sharedDraft}
            capturePagePaste={!searching}
            submitLabel="Add spark"
            onSubmit={async (input) => {
              const spark = await api.create(input);
              setSparks((prev) => [spark, ...prev]);
            }}
          />
        </div>

        {searching && !loading && (
          <p className="status">
            {sparks.length === 0
              ? "No sparks match."
              : `${sparks.length}${cursor ? "+" : ""} matching spark${sparks.length === 1 ? "" : "s"}`}
          </p>
        )}

        {groups.map((g) => (
          <section key={g.key} className="day">
            <h2 className="day-label">{g.label}</h2>
            {g.sparks.map((s) => (
              <SparkCard
                key={s.id}
                spark={s}
                terms={terms}
                onChanged={(updated) => setSparks((prev) => prev.map((p) => (p.id === updated.id ? updated : p)))}
                onDeleted={(id) => setSparks((prev) => prev.filter((p) => p.id !== id))}
                onOpenImage={(spark, index) => setLightbox({ images: spark.images, index })}
              />
            ))}
          </section>
        ))}

        {!searching && !loading && !error && sparks.length === 0 && (
          <p className="status empty">No sparks yet. Paste a link, jot a thought, or drop in a screenshot.</p>
        )}
        {error && (
          <p className="status form-error">
            {error}{" "}
            <button type="button" className="link-button" onClick={() => load(query, cursor)}>
              Retry
            </button>
          </p>
        )}
        {loading && <p className="status">Loading…</p>}
        {cursor && !loading && (
          <div ref={sentinelRef} className="load-more">
            <button type="button" className="button secondary" onClick={loadMore}>
              Load older sparks
            </button>
          </div>
        )}
      </main>

      {lightbox && (
        <Lightbox images={lightbox.images} startIndex={lightbox.index} onClose={() => setLightbox(null)} />
      )}
    </div>
  );
}
