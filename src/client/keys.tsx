import { useEffect, useRef } from "react";

export const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
export const MOD = isMac ? "⌘" : "Ctrl";

/** True when a keystroke belongs to a text field rather than to the page. */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el?.closest) return false;
  if (el.closest("textarea, select, [contenteditable]:not([contenteditable=false])")) return true;
  const input = el.closest("input");
  return !!input && !["button", "checkbox", "radio", "range", "file"].includes(input.type);
}

export function Kbd({ children }: { children: string }) {
  return <kbd className="kbd">{children}</kbd>;
}

/** Renders "j k" / "Ctrl Enter" style chords as separate keycaps. */
function Keys({ keys }: { keys: string[] }) {
  return (
    <span className="keys">
      {keys.map((k, i) =>
        k === "or" ? (
          <span key={i} className="keys-or">
            or
          </span>
        ) : (
          <Kbd key={i}>{k}</Kbd>
        ),
      )}
    </span>
  );
}

const SECTIONS: { title: string; rows: [string[], string][] }[] = [
  {
    title: "Feed",
    rows: [
      [["j", "k"], "Next / previous spark"],
      [["g", "G"], "First / last spark"],
      [["/"], "Search"],
      [["n"], "New spark"],
      [["Esc"], "Clear selection or search"],
    ],
  },
  {
    title: "Selected spark",
    rows: [
      [["o", "or", "↵"], "Open first link, else images"],
      [["v"], "View images"],
      [["e"], "Edit"],
      [["d"], "Delete"],
      [["y"], "Copy text"],
      [["m"], "Expand / collapse long text"],
    ],
  },
  {
    title: "Writing",
    rows: [
      [[MOD, "↵"], "Save"],
      [[MOD, "V"], "Paste image, from anywhere"],
      [["Esc"], "Leave the editor"],
    ],
  },
  {
    title: "Images",
    rows: [
      [["h", "l"], "Previous / next"],
      [["Esc"], "Close"],
    ],
  },
];

export function ShortcutHelp({ onClose }: { onClose(): void }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === "?" || e.key === "q") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return (
    <div className="overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="help" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts" tabIndex={-1} ref={ref}>
        <header className="help-header">
          <span>Keyboard shortcuts</span>
          <Kbd>Esc</Kbd>
        </header>
        <div className="help-body">
          {SECTIONS.map((s) => (
            <section key={s.title}>
              <h3>{s.title}</h3>
              <dl>
                {s.rows.map(([keys, label]) => (
                  <div key={label} className="help-row">
                    <dt>
                      <Keys keys={keys} />
                    </dt>
                    <dd>{label}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
