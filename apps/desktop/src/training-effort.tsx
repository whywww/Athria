import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { tr } from "./i18n";

export function TrainingEffort({ rpe, name, disabled, onSave }: { rpe: number | null | undefined; name: string; disabled: boolean; onSave: (value: number) => Promise<boolean> }) {
  const id = useId();
  const anchor = useRef<HTMLButtonElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const dirty = useRef(false);
  const saving = useRef(false);
  const tracking = useRef(false);
  const [draft, setDraft] = useState(rpe ?? 1);
  const [preview, setPreview] = useState<number | null>(null);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const place = () => {
    const rect = anchor.current?.getBoundingClientRect();
    if (!rect) return;
    const left = Math.max(8, Math.min(rect.left + rect.width / 2 - 50, window.innerWidth - 108));
    const below = rect.bottom;
    const top = below + 16 > window.innerHeight ? Math.max(8, rect.top - 16) : below;
    setPosition((current) => current.left === left && current.top === top ? current : { left, top });
  };
  useEffect(() => {
    const element = popover.current;
    if (!element) return;
    const onScroll = () => { if (tracking.current) place(); };
    const onToggle = (event: Event) => {
      if ((event as ToggleEvent).newState === "closed") { tracking.current = false; setPreview(null); }
    };
    window.addEventListener("scroll", onScroll, true);
    element.addEventListener("toggle", onToggle);
    return () => { window.removeEventListener("scroll", onScroll, true); element.removeEventListener("toggle", onToggle); };
  }, []);
  const commit = async (value: number, selected = false) => {
    if ((!dirty.current && !(selected && rpe == null)) || saving.current || disabled) return;
    dirty.current = false;
    if (value === rpe) { setPreview(null); return; }
    saving.current = true;
    try {
      if (!await onSave(value)) { setDraft(rpe ?? 1); setPreview(null); }
    } finally { saving.current = false; }
  };
  return <div className="training-effort-cell">
    <button ref={anchor} type="button" className="training-effort-value" disabled={disabled} popoverTarget={id} aria-label={`${tr("Edit effort")}: ${name}`} onClick={() => {
      if (popover.current?.matches(":popover-open")) return;
      dirty.current = false;
      setDraft(rpe ?? 1);
      tracking.current = true;
      place();
    }}>{preview ?? rpe ?? "-"}</button>
    <div id={id} ref={popover} popover="auto" className="training-effort-popover" style={position}>
      <input id={`${id}-range`} type="range" min="1" max="10" step="1" value={draft} disabled={disabled} aria-label={`${tr("Effort")}: ${name}`} style={{ "--training-effort-progress": `${(draft - 1) / 9 * 100}%` } as CSSProperties} onChange={(event) => {
        const value = Number(event.target.value);
        dirty.current = true;
        setDraft(value);
        setPreview(value);
      }} onPointerDown={(event) => event.currentTarget.setPointerCapture(event.pointerId)} onPointerUp={(event) => void commit(Number(event.currentTarget.value), true)} onPointerCancel={() => { dirty.current = false; setDraft(rpe ?? 1); setPreview(null); }} onKeyUp={(event) => {
        if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"].includes(event.key)) void commit(Number(event.currentTarget.value), true);
      }}/>
    </div>
  </div>;
}
