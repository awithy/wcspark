import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "./api";
import { Composer } from "./Composer";
import { fullTimestamp, timeLabel } from "./format";
import { RichText } from "./RichText";
import { thumbUrl, type Spark } from "../shared/types";

interface Props {
  spark: Spark;
  terms: string[];
  onChanged(spark: Spark): void;
  onDeleted(id: number): void;
  onOpenImage(spark: Spark, index: number): void;
}

export function SparkCard({ spark, terms, onChanged, onDeleted, onOpenImage }: Props) {
  const [mode, setMode] = useState<"view" | "edit" | "confirm-delete">("view");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const edited = spark.updatedAt - spark.createdAt > 60_000;

  const doDelete = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.remove(spark.id);
      onDeleted(spark.id);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <article className="spark" id={`spark-${spark.id}`}>
      <header className="spark-meta">
        <time dateTime={new Date(spark.createdAt).toISOString()} title={fullTimestamp(spark.createdAt)}>
          {timeLabel(spark.createdAt)}
        </time>
        {edited && (
          <span className="edited" title={`Edited ${fullTimestamp(spark.updatedAt)}`}>
            · edited
          </span>
        )}
        <span className="spacer" />
        {mode === "view" && (
          <Menu
            items={[
              { label: "Edit", onSelect: () => setMode("edit") },
              { label: "Delete", danger: true, onSelect: () => setMode("confirm-delete") },
            ]}
          />
        )}
      </header>

      {mode === "edit" ? (
        <Composer
          initial={{ blurb: spark.blurb, imageIds: spark.images.map((i) => i.id) }}
          submitLabel="Save"
          autoFocus
          onCancel={() => setMode("view")}
          onSubmit={async (input) => {
            onChanged(await api.update(spark.id, input));
            setMode("view");
          }}
        />
      ) : (
        <>
          {spark.blurb && <Blurb text={spark.blurb} terms={terms} />}
          {spark.images.length > 0 && <ImageGrid spark={spark} onOpen={(i) => onOpenImage(spark, i)} />}
        </>
      )}

      {mode === "confirm-delete" && (
        <div className="confirm-bar" role="alertdialog" aria-label="Confirm delete">
          <span>Delete this spark?</span>
          <span className="spacer" />
          <button type="button" className="button secondary" onClick={() => setMode("view")} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="button danger" onClick={doDelete} disabled={busy} autoFocus>
            {busy ? "Deleting…" : "Delete"}
          </button>
        </div>
      )}
      {error && <p className="form-error">{error}</p>}
    </article>
  );
}

const COLLAPSED_HEIGHT = 320;

function Blurb({ text, terms }: { text: string; terms: string[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [overflowing, setOverflowing] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el) setOverflowing(el.scrollHeight > COLLAPSED_HEIGHT + 40);
  }, [text]);

  const collapsed = overflowing && !expanded && terms.length === 0;
  return (
    <>
      <div
        ref={ref}
        className={`blurb${collapsed ? " collapsed" : ""}`}
        style={collapsed ? { maxHeight: COLLAPSED_HEIGHT } : undefined}
      >
        <RichText text={text} terms={terms} />
      </div>
      {overflowing && terms.length === 0 && (
        <button type="button" className="link-button" onClick={() => setExpanded(!expanded)}>
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </>
  );
}

// Feed previews are deliberately small; click through to the lightbox for the full image.
const SINGLE_MAX_WIDTH = 420;
const SINGLE_MAX_HEIGHT = 280;

/** Sizes a lone image within the preview box, never upscaling, with no layout shift. */
const singleImageStyle = (w: number, h: number) => ({
  aspectRatio: `${w} / ${h}`,
  width: `min(100%, ${SINGLE_MAX_WIDTH}px, ${Math.round((SINGLE_MAX_HEIGHT * w) / h)}px, ${w}px)`,
});

function ImageGrid({ spark, onOpen }: { spark: Spark; onOpen(index: number): void }) {
  const single = spark.images.length === 1;
  return (
    <div className={`images ${single ? "single" : "grid"}`}>
      {spark.images.map((img, i) => (
        <button
          type="button"
          key={img.id}
          className="image-button"
          onClick={() => onOpen(i)}
          aria-label={`Open image ${i + 1}`}
          style={single ? singleImageStyle(img.width, img.height) : undefined}
        >
          <img src={thumbUrl(img.id)} width={img.width} height={img.height} loading="lazy" decoding="async" alt="" />
        </button>
      ))}
    </div>
  );
}

interface MenuItem {
  label: string;
  danger?: boolean;
  onSelect(): void;
}

function Menu({ items }: { items: MenuItem[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: globalThis.KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="menu" ref={ref}>
      <button
        type="button"
        className="icon-button"
        aria-label="Spark actions"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          <circle cx="5" cy="12" r="2" fill="currentColor" />
          <circle cx="12" cy="12" r="2" fill="currentColor" />
          <circle cx="19" cy="12" r="2" fill="currentColor" />
        </svg>
      </button>
      {open && (
        <ul className="menu-list" role="menu">
          {items.map((item) => (
            <li key={item.label} role="none">
              <button
                type="button"
                role="menuitem"
                className={item.danger ? "danger" : undefined}
                onClick={() => {
                  setOpen(false);
                  item.onSelect();
                }}
              >
                {item.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
