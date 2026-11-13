import { useEffect, useRef, useState } from "react";
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
  const go = (delta: number) => setIndex((i) => (i + delta + images.length) % images.length);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft") go(-1);
      else if (e.key === "ArrowRight") go(1);
    };
    document.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
    };
  }, []);

  return (
    <div
      className="lightbox"
      role="dialog"
      aria-modal="true"
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
        {many && (
          <span className="lightbox-count">
            {index + 1} / {images.length}
          </span>
        )}
        <a href={imageUrl(img.id)} target="_blank" rel="noopener noreferrer">
          Open original
        </a>
        <button type="button" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>
      {many && (
        <>
          <button type="button" className="lightbox-nav prev" aria-label="Previous image" onClick={() => go(-1)}>
            ‹
          </button>
          <button type="button" className="lightbox-nav next" aria-label="Next image" onClick={() => go(1)}>
            ›
          </button>
        </>
      )}
    </div>
  );
}
