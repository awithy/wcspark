import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import { Composer, type ComposerHandle, type ComposerInitial } from "./Composer";
import { dayKey, dayLabel } from "./format";
import { MoonIcon, SearchIcon, SparkMark, SunIcon, SystemThemeIcon } from "./icons";
import { isTypingTarget, Kbd, ShortcutHelp } from "./keys";
import { Lightbox } from "./Lightbox";
import { firstUrl } from "./RichText";
import { SparkCard, type SparkHandle } from "./SparkCard";
import { nextTheme, themeLabel, useTheme } from "./theme";
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

/** Height of the sticky header plus a day label; sparks above this line count as scrolled past. */
const STICKY_OFFSET = 100;

export function App() {
  const [input, setInput] = useState(initialQuery);
  const [query, setQuery] = useState(initialQuery);
  const [sparks, setSparks] = useState<Spark[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<{ images: SparkImage[]; index: number } | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [freshId, setFreshId] = useState<number | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [toast, setToast] = useState<{ text: string; seq: number } | null>(null);
  const [theme, setTheme] = useTheme();
  const requestRef = useRef<AbortController | null>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const composerRef = useRef<ComposerHandle>(null);
  const cardRefs = useRef(new Map<number, SparkHandle>());

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
    setSelectedId(null);
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

  // Keep the keyboard selection on screen.
  useEffect(() => {
    if (selectedId != null) document.getElementById(`spark-${selectedId}`)?.scrollIntoView({ block: "nearest" });
  }, [selectedId]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 1800);
    return () => clearTimeout(t);
  }, [toast]);

  const notify = useCallback((text: string) => setToast((t) => ({ text, seq: (t?.seq ?? 0) + 1 })), []);

  const terms = useMemo(() => parseQuery(query), [query]);

  const groups = useMemo(() => {
    const out: { key: string; label: ReturnType<typeof dayLabel>; sparks: Spark[] }[] = [];
    for (const s of sparks) {
      const key = dayKey(s.createdAt);
      const last = out[out.length - 1];
      if (last?.key === key) last.sparks.push(s);
      else out.push({ key, label: dayLabel(s.createdAt), sparks: [s] });
    }
    return out;
  }, [sparks]);

  const searching = query.length > 0;

  const copySpark = useCallback(
    async (spark: Spark) => {
      if (!spark.blurb) return notify("Nothing to copy");
      try {
        await navigator.clipboard.writeText(spark.blurb);
        notify("Copied to clipboard");
      } catch {
        notify("Couldn't access the clipboard");
      }
    },
    [notify],
  );

  const sparksRef = useRef(sparks);
  sparksRef.current = sparks;

  const removeSpark = useCallback((id: number) => {
    // Move the selection to the neighbouring spark so j/k carry on from the same place.
    const prev = sparksRef.current;
    const i = prev.findIndex((p) => p.id === id);
    const neighbour = prev[i + 1] ?? prev[i - 1];
    setSelectedId((sel) => (sel === id ? (neighbour?.id ?? null) : sel));
    setSparks((list) => list.filter((p) => p.id !== id));
  }, []);

  const closeHelp = useCallback(() => setHelpOpen(false), []);

  const cycleTheme = useCallback(() => {
    const next = nextTheme(theme);
    setTheme(next);
    notify(`Theme: ${themeLabel(next)}`);
  }, [theme, setTheme, notify]);

  const focusComposer = useCallback(() => {
    if (searching || input) {
      setInput("");
      setQuery("");
    }
    setSelectedId(null);
    window.scrollTo({ top: 0 });
    requestAnimationFrame(() => composerRef.current?.focus());
  }, [searching, input]);

  // Feed-level keyboard shortcuts. Overlays (lightbox, help) capture their own keys first.
  const keyState = { sparks, selectedId, cursor, loadMore, copySpark, focusComposer, searching, notify, cycleTheme };
  const keyStateRef = useRef(keyState);
  keyStateRef.current = keyState;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e.target)) return;
      const s = keyStateRef.current;
      const index = s.sparks.findIndex((p) => p.id === s.selectedId);
      const selected = index >= 0 ? s.sparks[index]! : null;

      const move = (delta: number) => {
        if (!s.sparks.length) return;
        if (!selected) {
          // Start from whatever is at the top of the viewport rather than the top of the feed.
          const visible = s.sparks.find(
            (p) => (document.getElementById(`spark-${p.id}`)?.getBoundingClientRect().bottom ?? 0) > STICKY_OFFSET,
          );
          return setSelectedId((visible ?? s.sparks[0]!).id);
        }
        const next = s.sparks[Math.min(s.sparks.length - 1, Math.max(0, index + delta))]!;
        setSelectedId(next.id);
        if (index + delta >= s.sparks.length - 3 && s.cursor) s.loadMore();
      };

      switch (e.key) {
        case "j":
          move(1);
          break;
        case "k":
          move(-1);
          break;
        case "g":
          if (s.sparks[0]) setSelectedId(s.sparks[0].id);
          window.scrollTo({ top: 0 });
          break;
        case "G": {
          const last = s.sparks[s.sparks.length - 1];
          if (last) setSelectedId(last.id);
          break;
        }
        case "/":
          searchRef.current?.focus();
          searchRef.current?.select();
          break;
        case "n":
          s.focusComposer();
          break;
        case "?":
          setHelpOpen(true);
          break;
        case "t":
          s.cycleTheme();
          break;
        case "Escape":
          if (s.selectedId != null) setSelectedId(null);
          else if (s.searching) setInput("");
          else return;
          break;
        default: {
          if (!selected) return;
          const handle = cardRefs.current.get(selected.id);
          if (e.key === "e") handle?.edit();
          else if (e.key === "d" || e.key === "Delete") handle?.confirmDelete();
          else if (e.key === "m") handle?.toggleMore();
          else if (e.key === "y") void s.copySpark(selected);
          else if (e.key === "v") {
            if (selected.images.length) setLightbox({ images: selected.images, index: 0 });
            else s.notify("No images");
          } else if (e.key === "o" || (e.key === "Enter" && !(e.target as HTMLElement).closest?.("a, button"))) {
            const url = firstUrl(selected.blurb);
            if (url) window.open(url, "_blank", "noopener,noreferrer");
            else if (selected.images.length) setLightbox({ images: selected.images, index: 0 });
            else s.notify("Nothing to open");
          } else return;
        }
      }
      e.preventDefault();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="app">
      <header className="topbar">
        <a
          className="brand"
          href="/"
          onClick={(e) => {
            e.preventDefault();
            setInput("");
            setSelectedId(null);
            window.scrollTo({ top: 0 });
          }}
        >
          <span className="brand-mark">
            <SparkMark />
          </span>
          <span className="brand-name">sparks</span>
        </a>
        <label className={`search${input ? " has-value" : ""}`}>
          <SearchIcon />
          <input
            ref={searchRef}
            type="search"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                if (input) setInput("");
                else e.currentTarget.blur();
              } else if (e.key === "Enter" || e.key === "ArrowDown") {
                // Hand off to the results so j/k work straight away.
                e.preventDefault();
                setQuery(input.trim());
                e.currentTarget.blur();
                setSelectedId(null);
              }
            }}
            placeholder="Search"
            aria-label="Search sparks"
            spellCheck={false}
            autoComplete="off"
          />
          {searching && !loading && input.trim() === query ? (
            <span className="search-count">
              {sparks.length}
              {cursor ? "+" : ""} {sparks.length === 1 ? "match" : "matches"}
            </span>
          ) : (
            !input && (
              <span className="search-hint" aria-hidden="true">
                <Kbd>/</Kbd>
              </span>
            )
          )}
        </label>
        <button
          type="button"
          className="icon-button theme-button"
          onClick={cycleTheme}
          title={`Theme: ${themeLabel(theme)} (t)`}
          aria-label={`Theme: ${themeLabel(theme)}. Switch to ${themeLabel(nextTheme(theme))}`}
        >
          {theme === "light" ? <SunIcon /> : theme === "dark" ? <MoonIcon /> : <SystemThemeIcon />}
        </button>
      </header>

      <main>
        {/* Kept mounted while searching so an in-progress draft isn't lost. */}
        <div hidden={searching}>
          <Composer
            ref={composerRef}
            compact
            initial={sharedDraft ?? undefined}
            autoFocus={!!sharedDraft}
            capturePagePaste={!searching}
            submitLabel="Add"
            onSubmit={async (input) => {
              const spark = await api.create(input);
              setSparks((prev) => [spark, ...prev]);
              setFreshId(spark.id);
            }}
          />
        </div>

        {searching && !loading && sparks.length === 0 && (
          <p className="status">
            No sparks match <span className="status-query">{query}</span>
          </p>
        )}

        {groups.map((g) => (
          <section key={g.key} className="day">
            <h2 className="day-label">
              <span className="day-name">{g.label.name}</span>
              {g.label.date && <span className="day-date">{g.label.date}</span>}
            </h2>
            {g.sparks.map((s) => (
              <SparkCard
                key={s.id}
                ref={(h) => {
                  if (h) cardRefs.current.set(s.id, h);
                  else cardRefs.current.delete(s.id);
                }}
                spark={s}
                terms={terms}
                selected={s.id === selectedId}
                fresh={s.id === freshId}
                onSelect={() => setSelectedId(s.id)}
                onChanged={(updated) => setSparks((prev) => prev.map((p) => (p.id === updated.id ? updated : p)))}
                onDeleted={removeSpark}
                onCopy={copySpark}
                onOpenImage={(spark, index) => setLightbox({ images: spark.images, index })}
              />
            ))}
          </section>
        ))}

        {!searching && !loading && !error && sparks.length === 0 && (
          <div className="empty">
            <p>Nothing here yet.</p>
            <p className="empty-hint">
              Press <Kbd>n</Kbd> to write something, or paste a link or screenshot anywhere.
            </p>
          </div>
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
            <button type="button" className="button ghost" onClick={loadMore}>
              Load older sparks
            </button>
          </div>
        )}
        {!cursor && !loading && sparks.length > 0 && (
          <div className="feed-end" aria-hidden="true">
            <SparkMark />
          </div>
        )}
      </main>

      <button type="button" className="help-button" onClick={() => setHelpOpen(true)} aria-label="Keyboard shortcuts">
        <Kbd>?</Kbd>
        <span>shortcuts</span>
      </button>

      {toast && (
        <div className="toast" role="status" key={toast.seq}>
          {toast.text}
        </div>
      )}

      {helpOpen && <ShortcutHelp onClose={closeHelp} />}
      {lightbox && (
        <Lightbox images={lightbox.images} startIndex={lightbox.index} onClose={() => setLightbox(null)} />
      )}
    </div>
  );
}
