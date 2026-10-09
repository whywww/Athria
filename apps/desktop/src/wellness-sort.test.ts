import { beforeEach, describe, expect, it, vi } from "vitest";
import { useWellnessSort, wellnessDragOffset, wellnessDropSlot } from "./wellness-sort";

describe("wellness drag geometry", () => {
  const rows = [{ top: 100, height: 80 }, { top: 198, height: 160 }, { top: 376, height: 100 }];
  it("crosses layout midpoints, including unequal card heights and multiple slots", () => {
    expect([80, 140, 141, 278, 279, 500].map((y) => wellnessDropSlot(y, rows))).toEqual([0, 0, 1, 1, 2, 3]);
  });
  it("supports immediate reversal and both list boundaries", () => {
    expect([500, 300, 200, 0].map((y) => wellnessDropSlot(y, rows))).toEqual([3, 2, 1, 0]);
    expect(wellnessDropSlot(200, [])).toBe(0);
  });
  it("keeps the grabbed point under the pointer after reordering", () => {
    const y = 320, grabOffset = 35;
    for (const top of [100, 198, 376]) {
      expect(top + wellnessDragOffset(y, grabOffset, top) + grabOffset).toBe(y);
    }
  });
  it("compensates for scrolling even when the pointer stays still", () => {
    expect(wellnessDragOffset(200, 30, 100)).toBe(70);
    expect(wellnessDragOffset(200, 30, 84)).toBe(86);
  });
});

const harness = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0, layouts: [] as (() => void)[], effects: [] as (() => (() => void))[] }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = harness.cursor++;
    if (!(index in harness.values)) harness.values[index] = typeof initial === "function" ? initial() : initial;
    return [harness.values[index], (value: unknown) => { harness.values[index] = value; }];
  },
  useRef: (initial: unknown) => {
    const index = harness.cursor++;
    if (!(index in harness.values)) harness.values[index] = { current: initial };
    return harness.values[index];
  },
  useLayoutEffect: (effect: () => void) => { harness.layouts.push(effect); },
  useEffect: (effect: () => (() => void)) => { harness.effects.push(effect); },
}));

describe("wellness sort lifecycle", () => {
  beforeEach(() => {
    harness.values = []; harness.cursor = 0; harness.layouts = []; harness.effects = [];
    vi.stubGlobal("window", { matchMedia: () => ({ matches: false }), innerHeight: 1000, scrollBy: vi.fn() });
    vi.stubGlobal("document", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
  });
  const render = () => { harness.cursor = 0; harness.layouts = []; harness.effects = []; return useWellnessSort("test", ["sleep-score", "hrv"]); };
  function fixture() {
    const animation = { cancel: vi.fn(), onfinish: null as null | (() => void) };
    const row = {
      dataset: { metricId: "sleep-score" } as Record<string, string>, style: { transform: "" }, offsetTop: 0, offsetHeight: 100,
      getBoundingClientRect: () => ({ top: 100 + Number(row.style.transform.match(/-?[\d.]+/)?.[0] ?? 0) }),
      animate: vi.fn(() => animation),
    };
    const list = { querySelectorAll: () => [row], getBoundingClientRect: () => ({ top: 100 }), hasPointerCapture: () => true, releasePointerCapture: vi.fn(), setPointerCapture: vi.fn() };
    const handle = { closest: () => row, focus: vi.fn(), scrollIntoView: vi.fn() };
    const sort = render();
    sort.listRef.current = list as unknown as HTMLDivElement;
    return { sort, row, list, handle, animation };
  }
  function start(value: ReturnType<typeof fixture>) {
    value.sort.handleProps("sleep-score").onPointerDown({ isPrimary: true, button: 0, pointerId: 7, clientY: 125, currentTarget: value.handle, preventDefault: vi.fn() } as unknown as import("react").PointerEvent<HTMLButtonElement>);
  }
  it("lands from the final pointer position and releases capture", () => {
    const value = fixture(); start(value);
    value.sort.listProps.onPointerUp({ pointerId: 7, clientY: 185 } as import("react").PointerEvent<HTMLDivElement>);
    render(); harness.layouts.forEach((effect) => effect());
    expect(value.row.animate).toHaveBeenCalledWith([{ transform: "translateY(60px)" }, { transform: "translateY(0)" }], expect.objectContaining({ duration: 180 }));
    expect(value.list.releasePointerCapture).toHaveBeenCalledWith(7);
    expect(value.row.style.transform).toBe("");
    expect(value.row.dataset.sortDragging).toBeUndefined();
    value.animation.onfinish?.();
    expect(value.row.dataset.sortLanding).toBeUndefined();
  });
  it("cancels cleanly and supports immediate dragging with reduced motion", () => {
    vi.stubGlobal("window", { matchMedia: () => ({ matches: true }) });
    const value = fixture(); start(value);
    value.sort.listProps.onPointerMove({ pointerId: 7, clientY: 185 } as import("react").PointerEvent<HTMLDivElement>);
    value.sort.listProps.onPointerCancel({ pointerId: 7 } as import("react").PointerEvent<HTMLDivElement>);
    const next = render(); harness.layouts.forEach((effect) => effect());
    expect(next.activeId).toBeNull();
    expect(next.order).toEqual(value.sort.order);
    expect(value.row.animate).not.toHaveBeenCalled();
    expect(value.row.style.transform).toBe("");
  });
  it("retains keyboard focus and restores order on Escape", () => {
    const value = fixture();
    harness.effects.forEach((effect) => effect());
    const key = (key: string) => value.sort.handleProps("sleep-score").onKeyDown({ key, currentTarget: value.handle, preventDefault: vi.fn() } as unknown as import("react").KeyboardEvent<HTMLButtonElement>);
    key(" "); key("ArrowDown");
    const next = render(); harness.layouts.forEach((effect) => effect());
    expect(next.order.indexOf("sleep-score")).toBeGreaterThan(next.order.indexOf("hrv"));
    expect(value.handle.scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
    const escape = vi.mocked(document.addEventListener).mock.calls[0]![1] as unknown as (event: { key: string; preventDefault: () => void }) => void;
    escape({ key: "Escape", preventDefault: vi.fn() });
    expect(render().order).toEqual(value.sort.order);
  });
});
