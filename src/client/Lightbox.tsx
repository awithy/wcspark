import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, CloseIcon, ExternalIcon } from "./icons";
import { Kbd } from "./keys";
import { imageUrl, thumbUrl, type SparkImage } from "../shared/types";

interface Props {
  images: SparkImage[];
  startIndex: number;
  onClose(): void;
}

export function Lightbox({ images, startIndex, onClose }: Props) {
  const [index, setIndex] = useState(startIndex);
  const touchX = useRef<number | null>(null);
  const img = images[index]!;
  const many = images.length > 1;
  const indexRef = useRef(index);
  indexRef.current = index;
  const go = (delta: number) => setIndex((i) => (i + delta + images.length) % images.length);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === "Escape" || e.key === "q") onClose();
      else if (e.key === "ArrowLeft" || e.key === "h" || e.key === "k") go(-1);
      else if (e.key === "ArrowRight" || e.key === "l" || e.key === "j") go(1);
      else if (e.key === "o") window.open(imageUrl(images[indexRef.current]!.id), "_blank", "noopener");
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    // Capture phase, so the feed's shortcuts don't also fire underneath.
    document.addEventListener("keydown", onKey, true);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.body.style.overflow = overflow;
    };
  }, []);

  return (
    <div
      className="lightbox"
      role="dialog"
      aria-modal="true"
      aria-label="Image viewer"
      onClick={(e) => e.target === e.currentTarget && onClose()}
      onTouchStart={(e) => (touchX.current = e.touches[0]?.clientX ?? null)}
      onTouchEnd={(e) => {
        const start = touchX.current;
        const end = e.changedTouches[0]?.clientX;
        if (many && start != null && end != null && Math.abs(end - start) > 50) go(end < start ? 1 : -1);
        touchX.current = null;
      }}
    >
      {/* Show the cached thumbnail underneath while the original loads. */}
      <img
        key={img.id}
        className="lightbox-image"
        src={imageUrl(img.id)}
        style={{ backgroundImage: `url(${thumbUrl(img.id)})`, aspectRatio: `${img.width} / ${img.height}` }}
        alt=""
        onClick={onClose}
      />
      <div className="lightbox-toolbar">
        <span className="lightbox-info">
          {many && (
            <span className="lightbox-count">
              {index + 1} / {images.length}
            </span>
          )}
          <span className="lightbox-dims">
            {img.width} × {img.height}
          </span>
        </span>
        <span className="spacer" />
        <a className="lightbox-action" href={imageUrl(img.id)} target="_blank" rel="noopener noreferrer">
          <ExternalIcon /> Original <Kbd>o</Kbd>
        </a>
        <button type="button" className="lightbox-action" onClick={onClose} aria-label="Close">
          <CloseIcon size={16} /> <Kbd>Esc</Kbd>
        </button>
      </div>
      {many && (
        <>
          <button type="button" className="lightbox-nav prev" aria-label="Previous image" onClick={() => go(-1)}>
            <ChevronLeft />
          </button>
          <button type="button" className="lightbox-nav next" aria-label="Next image" onClick={() => go(1)}>
            <ChevronRight />
          </button>
        </>
      )}
    </div>
  );
}
