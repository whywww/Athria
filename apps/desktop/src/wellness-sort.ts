import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { currentLanguage, tr } from "./i18n";
import { moveMetric, readMetricOrder, saveMetricOrder, wellnessMetrics } from "./wellness-view";

interface SortSession {
  id: string;
  original: string[];
  mode: "pointer" | "keyboard";
  handle: HTMLButtonElement;
  y: number;
  pointerId: number | null;
}

export function useWellnessSort(databaseUuid: string, visibleIds: string[]) {
  const [order, setOrder] = useState(() => readMetricOrder(databaseUuid));
  const [activeId, setActiveId] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const orderRef = useRef(order);
  const visibleRef = useRef(visibleIds);
  visibleRef.current = visibleIds;
  const session = useRef<SortSession | null>(null);
  const frame = useRef<number | null>(null);
  const pendingFocus = useRef<HTMLButtonElement | null>(null);

  const announce = (id: string, status: string) => {
    const ids = orderRef.current.filter((value) => visibleRef.current.includes(value));
    const label = tr(wellnessMetrics.find((metric) => metric.id === id)!.label);
    setAnnouncement(`${status} · ${label} · ${tr("Position")} ${ids.indexOf(id) + 1} / ${ids.length}`);
  };
  const update = (next: string[]) => { orderRef.current = next; setOrder(next); };
  const finish = (cancel = false) => {
    const drag = session.current;
    if (!drag) return;
    session.current = null;
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    if (cancel) update(drag.original);
    else saveMetricOrder(databaseUuid, orderRef.current);
    setActiveId(null);
    announce(drag.id, tr(cancel ? "Reorder cancelled" : "Order saved"));
    pendingFocus.current = drag.handle;
  };
  const preview = () => {
    const drag = session.current, list = listRef.current;
    if (!drag || drag.mode !== "pointer" || !list) return;
    const rows = Array.from(list.querySelectorAll<HTMLElement>("[data-metric-id]"));
    const others = rows.filter((row) => row.dataset.metricId !== drag.id);
    const slot = others.filter((row) => { const rect = row.getBoundingClientRect(); return drag.y > rect.top + rect.height / 2; }).length;
    const ids = rows.map((row) => row.dataset.metricId!);
    if (ids.indexOf(drag.id) !== slot) {
      update(moveMetric(orderRef.current, drag.id, ids[slot]!));
      announce(drag.id, tr("Reordering"));
    }
  };
  const tick = () => {
    const drag = session.current, list = listRef.current;
    if (!drag || drag.mode !== "pointer" || !list) return;
    let scroller: HTMLElement | null = list.parentElement;
    while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
    const bounds = scroller?.getBoundingClientRect();
    const top = Math.max(0, bounds?.top ?? 0), bottom = Math.min(window.innerHeight, bounds?.bottom ?? window.innerHeight);
    const distance = drag.y < top + 56 ? -Math.min(16, (top + 56 - drag.y) / 3) : drag.y > bottom - 56 ? Math.min(16, (drag.y - bottom + 56) / 3) : 0;
    if (distance) { if (scroller) scroller.scrollTop += distance; else window.scrollBy(0, distance); }
    preview();
    frame.current = requestAnimationFrame(tick);
  };
  const begin = (id: string, handle: HTMLButtonElement, mode: SortSession["mode"], y = 0, pointerId: number | null = null) => {
    if (session.current) return;
    session.current = { id, original: [...orderRef.current], handle, mode, y, pointerId };
    setActiveId(id);
    announce(id, tr("Reordering"));
    if (mode === "pointer") frame.current = requestAnimationFrame(tick);
  };
  const pointerDown = (id: string, event: PointerEvent<HTMLButtonElement>) => {
    if (!event.isPrimary || event.button !== 0 || session.current) return;
    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
    listRef.current?.setPointerCapture(event.pointerId);
    begin(id, event.currentTarget, "pointer", event.clientY, event.pointerId);
  };
  const pointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (session.current?.mode === "pointer" && session.current.pointerId === event.pointerId) session.current.y = event.clientY;
  };
  const keyDown = (id: string, event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      if (!session.current) begin(id, event.currentTarget, "keyboard");
      else if (session.current.mode === "keyboard") finish();
    } else if (session.current?.mode === "keyboard" && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
      event.preventDefault();
      const ids = orderRef.current.filter((value) => visibleRef.current.includes(value));
      const index = ids.indexOf(id), target = ids[index + (event.key === "ArrowUp" ? -1 : 1)];
      if (target) { update(moveMetric(orderRef.current, id, target)); announce(id, tr("Reordering")); }
    }
  };
  useLayoutEffect(() => {
    if (pendingFocus.current) { pendingFocus.current.focus({ preventScroll: true }); pendingFocus.current = null; }
    if (session.current?.mode === "keyboard") {
      session.current.handle.focus({ preventScroll: true });
      session.current.handle.scrollIntoView({ block: "nearest" });
    }
  }, [order, activeId]);
  useEffect(() => {
    const escape = (event: globalThis.KeyboardEvent) => { if (event.key === "Escape" && session.current) { event.preventDefault(); finish(true); } };
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("keydown", escape); if (frame.current !== null) cancelAnimationFrame(frame.current); };
  }, [databaseUuid]);

  return { order, activeId, announcement, listRef, listProps: {
    onPointerMove: pointerMove,
    onPointerUp: (event: PointerEvent<HTMLDivElement>) => { if (session.current?.mode === "pointer" && session.current.pointerId === event.pointerId) { session.current.y = event.clientY; preview(); finish(); } },
    onPointerCancel: (event: PointerEvent<HTMLDivElement>) => { if (session.current?.pointerId === event.pointerId) finish(true); },
    onLostPointerCapture: (event: PointerEvent<HTMLDivElement>) => { if (session.current?.mode === "pointer" && session.current.pointerId === event.pointerId) finish(true); },
  }, handleProps: (id: string) => ({
    className: "wellness-sort-handle",
    "aria-label": `${tr("Reorder metric")}: ${tr(wellnessMetrics.find((metric) => metric.id === id)!.label)}`,
    "aria-pressed": activeId === id,
    title: tr("Use Space or Enter to reorder, arrow keys to move, and Escape to cancel."),
    onPointerDown: (event: PointerEvent<HTMLButtonElement>) => pointerDown(id, event),
    onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => keyDown(id, event),
    onBlur: () => { if (session.current?.mode === "keyboard") finish(true); },
    lang: currentLanguage(),
  }) };
}
