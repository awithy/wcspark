import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type KeyboardEvent, type Ref } from "react";
import { api } from "./api";
import { Composer } from "./Composer";
import { fullTimestamp, timeLabel } from "./format";
import { CopyIcon, EditIcon, TrashIcon } from "./icons";
import { Kbd } from "./keys";
import { RichText } from "./RichText";
import { thumbUrl, type Spark } from "../shared/types";

/** Actions the feed's keyboard handler can trigger on a spark. */
export interface SparkHandle {
  edit(): void;
  confirmDelete(): void;
  toggleMore(): void;
}

interface Props {
  spark: Spark;
  terms: string[];
  selected: boolean;
  fresh: boolean;
  ref?: Ref<SparkHandle>;
  onSelect(): void;
  onChanged(spark: Spark): void;
  onDeleted(id: number): void;
  onCopy(spark: Spark): void;
  onOpenImage(spark: Spark, index: number): void;
}

export function SparkCard({ spark, terms, selected, fresh, ref, onSelect, onChanged, onDeleted, onCopy, onOpenImage }: Props) {
  const [mode, setMode] = useState<"view" | "edit" | "confirm-delete">("view");
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const articleRef = useRef<HTMLElement>(null);
  const edited = spark.updatedAt - spark.createdAt > 60_000;

  // The editor and delete prompt make the row taller; keep all of it in view.
  useEffect(() => {
    if (mode !== "view") articleRef.current?.scrollIntoView({ block: "nearest" });
  }, [mode]);

  useImperativeHandle(ref, () => ({
    edit: () => setMode("edit"),
    confirmDelete: () => setMode("confirm-delete"),
    toggleMore: () => setExpanded((x) => !x),
  }));

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

  const onConfirmKey = (e: KeyboardEvent) => {
    if (busy) return;
    if (e.key === "y") void doDelete();
    else if (e.key === "Escape" || e.key === "n") setMode("view");
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  const classes = ["spark", selected && "selected", fresh && "fresh", mode !== "view" && mode].filter(Boolean);

  return (
    <article ref={articleRef} className={classes.join(" ")} id={`spark-${spark.id}`} onMouseDown={onSelect}>
      <div className="spark-gutter">
        <time dateTime={new Date(spark.createdAt).toISOString()} title={fullTimestamp(spark.createdAt)}>
          {timeLabel(spark.createdAt)}
        </time>
        {edited && (
          <span className="edited" title={`Edited ${fullTimestamp(spark.updatedAt)}`}>
            edited
          </span>
        )}
      </div>

      <div className="spark-body">
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
            {spark.blurb && (
              <Blurb text={spark.blurb} terms={terms} expanded={expanded} onToggle={() => setExpanded(!expanded)} />
            )}
            {spark.images.length > 0 && <ImageGrid spark={spark} onOpen={(i) => onOpenImage(spark, i)} />}
          </>
        )}

        {mode === "confirm-delete" && (
          <div className="confirm-bar" role="alertdialog" aria-label="Confirm delete" onKeyDown={onConfirmKey}>
            <span>Delete this spark?</span>
            <span className="spacer" />
            <button type="button" className="button ghost" onClick={() => setMode("view")} disabled={busy}>
              Cancel <Kbd>Esc</Kbd>
            </button>
            <button type="button" className="button danger" onClick={doDelete} disabled={busy} autoFocus>
              {busy ? "Deleting…" : "Delete"} <Kbd>y</Kbd>
            </button>
          </div>
        )}
        {error && <p className="form-error">{error}</p>}
      </div>

      {mode === "view" && (
        <div className="spark-actions">
          {spark.blurb && (
            <button type="button" className="icon-button" title="Copy text (y)" aria-label="Copy text" onClick={() => onCopy(spark)}>
              <CopyIcon />
            </button>
          )}
          <button type="button" className="icon-button" title="Edit (e)" aria-label="Edit" onClick={() => setMode("edit")}>
            <EditIcon />
          </button>
          <button
            type="button"
            className="icon-button danger"
            title="Delete (d)"
            aria-label="Delete"
            onClick={() => setMode("confirm-delete")}
          >
            <TrashIcon />
          </button>
        </div>
      )}
    </article>
  );
}

const COLLAPSED_HEIGHT = 300;

function Blurb({ text, terms, expanded, onToggle }: { text: string; terms: string[]; expanded: boolean; onToggle(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [overflowing, setOverflowing] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el) setOverflowing(el.scrollHeight > COLLAPSED_HEIGHT + 60);
  }, [text]);

  const collapsible = overflowing && terms.length === 0;
  const collapsed = collapsible && !expanded;
  return (
    <>
      <div
        ref={ref}
        className={`blurb${collapsed ? " collapsed" : ""}`}
        style={collapsed ? { maxHeight: COLLAPSED_HEIGHT } : undefined}
      >
        <RichText text={text} terms={terms} />
      </div>
      {collapsible && (
        <button type="button" className="more-button" onClick={onToggle}>
          {expanded ? "Show less" : "Show more"}
          <Kbd>m</Kbd>
        </button>
      )}
    </>
  );
}

// Feed previews are deliberately small; click through to the lightbox for the full image.
const SINGLE_MAX_WIDTH = 440;
const SINGLE_MAX_HEIGHT = 260;

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
