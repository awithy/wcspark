import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type Ref,
} from "react";
import { api } from "./api";
import { CloseIcon, ImageIcon } from "./icons";
import { Kbd, MOD } from "./keys";
import { MAX_BLURB_LENGTH, MAX_IMAGES_PER_SPARK, thumbUrl, type SparkInput } from "../shared/types";

interface DraftImage {
  key: string;
  /** Set once the upload has finished. */
  id?: string;
  /** Local object URL while uploading; falls back to the server thumbnail. */
  preview?: string;
  error?: string;
}

export interface ComposerInitial {
  blurb?: string | null;
  imageIds?: string[];
}

interface Props {
  initial?: ComposerInitial;
  submitLabel: string;
  onSubmit(input: SparkInput): Promise<void>;
  onCancel?(): void;
  autoFocus?: boolean;
  /** Also accept image pastes made while nothing else is focused (main composer only). */
  capturePagePaste?: boolean;
  placeholder?: string;
  /** Collapse to a single line while unfocused and empty (main composer only). */
  compact?: boolean;
  ref?: Ref<ComposerHandle>;
}

export interface ComposerHandle {
  focus(): void;
}

let keySeq = 0;
const nextKey = () => `img-${++keySeq}`;

export function Composer({
  initial,
  submitLabel,
  onSubmit,
  onCancel,
  autoFocus,
  capturePagePaste,
  placeholder,
  compact,
  ref,
}: Props) {
  const [blurb, setBlurb] = useState(initial?.blurb ?? "");
  const [images, setImages] = useState<DraftImage[]>(
    () => initial?.imageIds?.map((id) => ({ key: nextKey(), id })) ?? [],
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imagesRef = useRef(images);
  imagesRef.current = images;

  // Auto-grow the textarea.
  useLayoutEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${ta.scrollHeight}px`;
  }, [blurb]);

  const focusEnd = useCallback(() => {
    const ta = textareaRef.current;
    ta?.focus();
    ta?.setSelectionRange(ta.value.length, ta.value.length);
  }, []);

  useImperativeHandle(ref, () => ({ focus: focusEnd }), [focusEnd]);

  useEffect(() => {
    if (autoFocus) focusEnd();
  }, [autoFocus, focusEnd]);

  // Revoke object URLs on unmount.
  useEffect(() => () => imagesRef.current.forEach((i) => i.preview && URL.revokeObjectURL(i.preview)), []);

  const addFiles = useCallback((files: Iterable<File>) => {
    const imageFiles = [...files].filter((f) => f.type.startsWith("image/"));
    const room = MAX_IMAGES_PER_SPARK - imagesRef.current.length;
    if (imageFiles.length > room) setError(`At most ${MAX_IMAGES_PER_SPARK} images per spark`);
    for (const file of imageFiles.slice(0, Math.max(0, room))) {
      const draft: DraftImage = { key: nextKey(), preview: URL.createObjectURL(file) };
      setImages((imgs) => [...imgs, draft]);
      api.uploadImage(file).then(
        (img) => setImages((imgs) => imgs.map((i) => (i.key === draft.key ? { ...i, id: img.id } : i))),
        (err: Error) =>
          setImages((imgs) => imgs.map((i) => (i.key === draft.key ? { ...i, error: err.message } : i))),
      );
    }
  }, []);

  // Page-level paste: lets you hit Ctrl+V anywhere to drop a screenshot into the main composer.
  useEffect(() => {
    if (!capturePagePaste) return;
    const onPaste = (e: ClipboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest("input, textarea, [contenteditable]")) return;
      const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith("image/"));
      const text = e.clipboardData?.getData("text/plain");
      if (!files.length && !text) return;
      e.preventDefault();
      if (files.length) addFiles(files);
      else if (text) setBlurb((b) => (b ? `${b}\n${text}` : text).slice(0, MAX_BLURB_LENGTH));
      textareaRef.current?.focus();
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [capturePagePaste, addFiles]);

  const removeImage = (key: string) => {
    setImages((imgs) => {
      const img = imgs.find((i) => i.key === key);
      if (img?.preview) URL.revokeObjectURL(img.preview);
      return imgs.filter((i) => i.key !== key);
    });
  };

  const uploading = images.some((i) => !i.id && !i.error);
  const failed = images.some((i) => i.error);
  const tooLong = blurb.length > MAX_BLURB_LENGTH;
  const empty = !blurb.trim() && images.length === 0;
  const canSubmit = !saving && !uploading && !failed && !tooLong && !empty;

  const submit = async () => {
    if (!canSubmit) return;
    setSaving(true);
    setError(null);
    try {
      await onSubmit({ blurb: blurb.trim() || null, imageIds: images.map((i) => i.id!) });
      // Reset (only matters for the main composer; edit composers unmount).
      images.forEach((i) => i.preview && URL.revokeObjectURL(i.preview));
      setBlurb("");
      setImages([]);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void submit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (onCancel) onCancel();
      else (document.activeElement as HTMLElement | null)?.blur();
    }
  };

  const onDrag = (e: DragEvent, over: boolean) => {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    setDragging(over);
  };

  const charsLeft = MAX_BLURB_LENGTH - blurb.length;
  const classes = ["composer", compact && "compact", !empty && "has-content", dragging && "dragging"];

  return (
    <div
      className={classes.filter(Boolean).join(" ")}
      onKeyDown={onKeyDown}
      onDragOver={(e) => onDrag(e, true)}
      onDragEnter={(e) => onDrag(e, true)}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false);
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        setDragging(false);
        addFiles(e.dataTransfer.files);
      }}
    >
      {compact && (
        <span className="composer-idle-hint" aria-hidden="true">
          <Kbd>n</Kbd>
        </span>
      )}
      <textarea
        ref={textareaRef}
        value={blurb}
        rows={1}
        aria-label="Spark text"
        placeholder={placeholder ?? "Capture a thought, link, or screenshot…"}
        onChange={(e) => setBlurb(e.target.value)}
        onPaste={(e) => {
          const files = [...e.clipboardData.files].filter((f) => f.type.startsWith("image/"));
          if (files.length) {
            e.preventDefault();
            addFiles(files);
          }
        }}
      />

      {images.length > 0 && (
        <ul className="draft-images">
          {images.map((img) => (
            <li key={img.key} className={img.error ? "error" : !img.id ? "uploading" : ""}>
              <img src={img.preview ?? thumbUrl(img.id!)} alt="" />
              {!img.id && !img.error && <span className="spinner" aria-label="Uploading" />}
              {img.error && (
                <span className="img-error" title={img.error}>
                  !
                </span>
              )}
              <button type="button" className="remove" aria-label="Remove image" onClick={() => removeImage(img.key)}>
                <CloseIcon size={12} />
              </button>
            </li>
          ))}
        </ul>
      )}

      {error && <p className="form-error">{error}</p>}
      {failed && <p className="form-error">Some images failed to upload — remove them to continue.</p>}

      <div className="composer-actions">
        <button
          type="button"
          className="icon-button"
          title="Add images"
          aria-label="Add images"
          onClick={() => fileInputRef.current?.click()}
        >
          <ImageIcon size={17} />
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files) addFiles(e.target.files);
            e.target.value = "";
          }}
        />
        {charsLeft < 500 && <span className={`char-count${tooLong ? " over" : ""}`}>{charsLeft}</span>}
        <span className="spacer" />
        {onCancel && (
          <button type="button" className="button ghost" onClick={onCancel} disabled={saving}>
            Cancel <Kbd>Esc</Kbd>
          </button>
        )}
        <button type="button" className="button primary" onClick={submit} disabled={!canSubmit}>
          {saving ? "Saving…" : uploading ? "Uploading…" : submitLabel}
          <span className="button-keys">
            <Kbd>{MOD}</Kbd>
            <Kbd>↵</Kbd>
          </span>
        </button>
      </div>
    </div>
  );
}
