import { createElement, useEffect, useRef, type ReactElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
vi.mock("react", async (importOriginal) => {
  const react = await importOriginal<typeof import("react")>();
  return { ...react, useRef: vi.fn(react.useRef), useEffect: vi.fn(react.useEffect) };
});
import { LanguageProvider, zh } from "./i18n";
import { SleepDurationInput, SleepSlider, WellnessMetricRow } from "./WellnessPage";
import { eveningWellnessRecords, sleepStorageDay, metricNumber, moveMetric, normalizeMetricOrder, readMetricOrder, saveMetricOrder, sleepCanReset, sleepDraft, sleepHasChanges, sleepPatch, wellnessMetrics, wellnessSeries, wellnessWindow } from "./wellness-view";
import type { WellnessRecord } from "./view-models";

const record = (day: string, values: Partial<Record<keyof WellnessRecord["fields"], number | null>>): WellnessRecord => ({ ownerId: "local-user", day, fields: Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { value, source: key === "subjectiveSleepScore" || key === "manualSleepSeconds" ? "user" : "intervals_icu", updatedAt: "2026-10-09T00:00:00Z" }])), updatedAt: "2026-10-09T00:00:00Z" });
const scoreMetric = wellnessMetrics[0]!;

describe("wellness trends", () => {
  it("combines HRV on one scale with metric colors, gaps and accessible source labels", () => {
    const metric = wellnessMetrics.find((item) => item.id === "hrv")!;
    const records = [record("2026-10-01", { hrvRmssdMs: 0, hrvSdnnMs: 40 }), record("2026-10-03", { hrvRmssdMs: 50 })];
    const chart = wellnessSeries(records, metric, "2026-10-01", "2026-10-07");
    expect(chart.series.map(({ tone }) => tone)).toEqual(["device", "manual"]);
    expect(chart.series[0]!.segments).toHaveLength(2);
    expect(chart.series.flatMap(({ points }) => points).every(({ y }) => Number.isFinite(y))).toBe(true);
    const render = (data: WellnessRecord[]) => renderToStaticMarkup(createElement(WellnessMetricRow, { metric, records: data, start: "2026-10-01", end: "2026-10-07" }));
    const html = render(records);
    expect(html).toContain("<h2>HRV</h2>");
    expect(html).toContain("0 ms · Intervals.icu RMSSD");
    expect(html).toContain("40 ms · Intervals.icu SDNN");
    expect(render([record("2026-10-01", { hrvSdnnMs: 30 })])).not.toContain("Intervals.icu RMSSD");
    records[0]!.fields.hrvRmssdMs!.source = "user";
    expect(render(records)).toContain("Manual record RMSSD");
    expect(zh["HRV"]).toBe("心率变异性");
    expect(zh["VO2 max"]).toBe("最大摄氧量");
    expect(zh["SpO2"]).toBe("血氧饱和度");
  });
  it("uses seven actual weekday ticks across year and leap-day boundaries without changing chart dimensions", () => {
    const render = (start: string, end: string, weekly = true) => renderToStaticMarkup(createElement(WellnessMetricRow, { metric: scoreMetric, records: [], start, end, weekly }));
    const year = render("2025-12-27", "2026-01-02");
    const labels = [...year.matchAll(/y="97"[^>]*>([^<]+)<\/text>/g)].map((match) => match[1]);
    expect(labels).toEqual(["Sat", "Sun", "Mon", "Tue", "Wed", "Thu", "Fri"]);
    expect(render("2024-02-24", "2024-03-01")).toContain(">Thu</text>");
    expect(year).toContain('viewBox="0 0 800 103"');
    expect(render("2026-09-10", "2026-10-09", false)).toContain(">Sep 10</text>");
  });
  it("uses rolling periods with timezone padding and expands the local query for older periods", () => {
    expect(wellnessWindow("2026-10-09", 7, 0)).toEqual({ start: "2026-10-03", end: "2026-10-09", days: 9 });
    expect(wellnessWindow("2026-10-09", 365, 1)).toEqual({ start: "2024-10-10", end: "2025-10-09", days: 732 });
    expect(wellnessWindow("2024-03-01", 7, 0).start).toBe("2024-02-24");
    expect(wellnessWindow("2026-01-02", 7, 0).start).toBe("2025-12-27");
    expect(wellnessWindow("2026-10-09", 30, -1)).toEqual(wellnessWindow("2026-10-09", 30, 0));
    expect(wellnessWindow("2026-10-09", 183, 2).days).toBe(551);
  });
  it("keeps device and subjective sleep in independent series and does not join across missing days", () => {
    const chart = wellnessSeries([record("2026-10-02", { sleepScore: 70, subjectiveSleepScore: 80 }), record("2026-10-03", { sleepScore: 75 }), record("2026-10-05", { sleepScore: 85 }), record("2026-10-06", { sleepScore: null }), record("2026-10-10", { sleepScore: 90 })], scoreMetric, "2026-10-01", "2026-10-07");
    expect(chart.series).toHaveLength(2);
    const device = chart.series.find((series) => series.key === "sleepScore")!;
    expect(device.segments.map((segment) => segment.map((point) => point.day))).toEqual([["2026-10-01", "2026-10-02"], ["2026-10-04"]]);
    expect(chart.series.find((series) => series.key === "subjectiveSleepScore")!.points[0]).toMatchObject({ value: 80, source: "user" });
  });
  it("renders constant and zero readings with finite coordinates and converts duration to hours", () => {
    const records = [record("2026-10-01", { sleepScore: 0 }), record("2026-10-02", { sleepScore: 0 })];
    const chart = wellnessSeries(records, scoreMetric, "2026-10-01", "2026-10-02");
    expect(chart.high).toBeGreaterThan(chart.low);
    expect(chart.series[0]!.points.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y))).toBe(true);
    const duration = wellnessSeries([record("2026-10-02", { sleepSeconds: 27000, manualSleepSeconds: 25200 })], wellnessMetrics[1]!, "2026-10-01", "2026-10-01");
    expect(duration.series.map((series) => series.points[0]!.value)).toEqual([7.5, 7]);
  });
  it("excludes power metrics and notes and always keeps both sleep rows available", () => {
    expect(wellnessMetrics.flatMap((metric) => metric.keys)).not.toEqual(expect.arrayContaining(["eftpWatts", "wPrimeJoules", "pMaxWatts", "notes"]));
    expect(wellnessMetrics.filter((metric) => metric.always).map((metric) => metric.id)).toEqual(["sleep-score", "sleep-duration"]);
    expect(wellnessMetrics.find((metric) => metric.id === "readiness")?.label).toBe("Source readiness");
    expect(metricNumber(record("2026-10-01", { sleepScore: null }), "sleepScore")).toBeNull();
  });
  it("renders accessible dates and source legends without an inline recording button", () => {
    const render = (records: WellnessRecord[]) => renderToStaticMarkup(createElement(WellnessMetricRow, { metric: scoreMetric, records, start: "2026-10-01", end: "2026-10-07" }));
    expect(render([])).not.toContain("No records in this period.");
    for (const records of [[], [record("2026-10-01", { sleepScore: 80 })]]) {
      expect(render(records)).not.toContain("wellness-latest");
      expect(render(records)).not.toContain("wellness-point-detail");
      expect(render(records)).not.toContain("Select a point");
    }
    expect(render([])).toContain("<h2>Sleep score</h2>");
    expect(render([])).not.toContain("Record sleep");
    const html = render([record("2026-10-02", { sleepScore: 80, subjectiveSleepScore: 60 })]);
    expect(html).toContain('tabindex="0" role="img"');
    expect(html).toContain("80 points · Intervals.icu");
    expect(html).toContain("60 points · Subjective sleep score");
    expect(html).not.toContain("NaN");
  });
  it("localizes the new metric labels and help", () => {
    vi.stubGlobal("localStorage", { getItem: () => "zh-CN", setItem: () => {} });
    try {
      const html = renderToStaticMarkup(createElement(LanguageProvider, null, createElement(WellnessMetricRow, { metric: scoreMetric, records: [], start: "2026-10-01", end: "2026-10-07", weekly: true })));
      expect(html).not.toContain("记录睡眠"); expect(html).not.toContain("此时间段暂无记录");
      expect(html).toContain(">周四</text>"); expect(html).toContain(">周三</text>");
      expect(zh["Wellness week"]).toBe("周"); expect(zh["Wellness back"]).toBe("返回");
      const duration = renderToStaticMarkup(createElement(WellnessMetricRow, { metric: wellnessMetrics[1]!, records: [], start: "2026-10-01", end: "2026-10-07" }));
      expect(duration).toContain("<h2>睡眠时间</h2>");
      expect(zh["Sleep"]).toBe("睡眠");
      for (const label of ["Back to Overview", "Subjective sleep score", "Manual sleep duration", "Source readiness", "Based on HRV and resting HR · Sleep not included"]) expect(zh[label]).toBeTruthy();
    } finally {
      vi.stubGlobal("localStorage", { getItem: () => "en", setItem: () => {} });
      renderToStaticMarkup(createElement(LanguageProvider, null, createElement("span")));
      vi.unstubAllGlobals();
    }
  });
});

describe("wellness metric order", () => {
  it("merges legacy HRV IDs at their first saved position", () => {
    expect(normalizeMetricOrder(["weight", "hrv-sdnn", "steps", "hrv-rmssd"]).slice(0, 3)).toEqual(["weight", "hrv", "steps"]);
    expect(normalizeMetricOrder(["hrv-rmssd", "weight", "hrv-sdnn"]).slice(0, 2)).toEqual(["hrv", "weight"]);
  });
  it("defaults to the requested order and places other metrics afterwards", () => {
    const order = readMetricOrder("new", { getItem: () => null });
    expect(order.slice(0, 8)).toEqual(["hrv", "resting-hr", "steps", "oxygen", "sleep-score", "sleep-duration", "vo2max", "weight"]);
    expect(order.slice(8)).toEqual(wellnessMetrics.map((metric) => metric.id).filter((id) => !order.slice(0, 8).includes(id)));
  });
  it("ignores invalid and duplicate IDs and appends missing metrics", () => {
    const normalized = normalizeMetricOrder(["weight", "invalid", "weight", 123, "sleep-score"]);
    expect(normalized.slice(0, 2)).toEqual(["weight", "sleep-score"]);
    expect(new Set(normalized).size).toBe(wellnessMetrics.length);
    expect(normalizeMetricOrder({})).toEqual(normalizeMetricOrder(null));
  });
  it("moves in both directions while retaining hidden metric positions and leaving the original available for cancellation", () => {
    const original = ["sleep-score", "hidden", "sleep-duration", "weight"];
    expect(moveMetric(original, "weight", "sleep-score")).toEqual(["weight", "sleep-score", "hidden", "sleep-duration"]);
    expect(moveMetric(original, "sleep-score", "weight")).toEqual(["hidden", "sleep-duration", "weight", "sleep-score"]);
    expect(original).toEqual(["sleep-score", "hidden", "sleep-duration", "weight"]);
    expect(moveMetric(original, "unknown", "weight")).toBe(original);
  });
  it("persists all metric IDs independently per database and survives unavailable or corrupt storage", () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    saveMetricOrder("one", ["weight", "sleep-duration"], storage);
    saveMetricOrder("two", ["steps"], storage);
    expect(readMetricOrder("one", storage).slice(0, 2)).toEqual(["weight", "sleep-duration"]);
    expect(readMetricOrder("two", storage)[0]).toBe("steps");
    expect(readMetricOrder("one", storage)).toHaveLength(wellnessMetrics.length);
    expect(readMetricOrder("corrupt", { getItem: () => "{" })).toEqual(normalizeMetricOrder(null));
    expect(readMetricOrder("blocked", { getItem: () => { throw new Error("blocked"); } })).toEqual(normalizeMetricOrder(null));
    expect(() => saveMetricOrder("blocked", [], { setItem: () => { throw new Error("blocked"); } })).not.toThrow();
  });
});

describe("manual sleep entries", () => {
  it.each([0, 80])("falls back to API score %s without writing a manual score", (score) => {
    const api = record("2026-10-09", { sleepScore: score, sleepSeconds: 27045 });
    const draft = sleepDraft(api);
    expect(draft.score).toBe(String(score));
    expect(sleepPatch(draft, api)).toEqual({});
    expect(sleepCanReset(draft, api, {}, "score")).toBe(false);
    expect(sleepCanReset(draft, api, {}, "duration")).toBe(false);
    expect(sleepPatch({ ...draft, hours: "8" }, api)).toEqual({ manualSleepSeconds: 30600 });
  });
  it.each([false, true])("clears stored manual overrides even when their display matches API (%s)", (same) => {
    const stored = record("2026-10-09", { subjectiveSleepScore: same ? 80 : 0, sleepScore: 80, manualSleepSeconds: same ? 27045 : 0, sleepSeconds: 27045 });
    const initial = sleepDraft(stored);
    expect(sleepCanReset(initial, stored, {}, "score")).toBe(true);
    expect(sleepCanReset(initial, stored, {}, "duration")).toBe(true);
    const cleared = { score: true, duration: true };
    const fallback = sleepDraft(stored, cleared);
    expect(fallback).toEqual({ score: "80", hours: "7", minutes: "30" });
    expect(sleepPatch(fallback, stored, cleared)).toEqual({ subjectiveSleepScore: null, manualSleepSeconds: null });
    expect(sleepHasChanges(fallback, stored, cleared)).toBe(true);
    expect(sleepCanReset(fallback, stored, cleared, "score")).toBe(false);
    expect(sleepCanReset(fallback, stored, cleared, "duration")).toBe(false);
    expect(stored.fields.sleepScore?.value).toBe(80);
    expect(stored.fields.sleepSeconds?.value).toBe(27045);
  });
  it("clears manual-only records to empty and preserves edits in the other field", () => {
    const stored = record("2026-10-09", { subjectiveSleepScore: 70, manualSleepSeconds: 27045 });
    const empty = sleepDraft(stored, { score: true, duration: true });
    expect(empty).toEqual(sleepDraft());
    expect(sleepPatch(empty, stored, { score: true, duration: true })).toEqual({ subjectiveSleepScore: null, manualSleepSeconds: null });
    expect(sleepPatch({ ...empty, score: "85" }, stored, { duration: true })).toEqual({ subjectiveSleepScore: 85, manualSleepSeconds: null });
    expect(sleepPatch({ ...empty, hours: "8", minutes: "0" }, stored, { score: true })).toEqual({ subjectiveSleepScore: null, manualSleepSeconds: 28800 });
  });
  it("discards API-only edits on reset without creating or deleting API fields", () => {
    const api = record("2026-10-09", { sleepScore: 80, sleepSeconds: 27045 });
    const edited = { score: "75", hours: "8", minutes: "0" };
    expect(sleepCanReset(edited, api, {}, "score")).toBe(true);
    expect(sleepCanReset(edited, api, {}, "duration")).toBe(true);
    const cleared = { score: true, duration: true };
    expect(sleepPatch(sleepDraft(api, cleared), api, cleared)).toEqual({});
    expect(sleepHasChanges(sleepDraft(api, cleared), api, cleared)).toBe(false);
    expect(sleepPatch({ ...sleepDraft(api), score: "75" }, api, { score: false, duration: true })).toEqual({ subjectiveSleepScore: 75 });
  });
  it("prefers manual duration including zero and falls back to API duration without creating an override", () => {
    const api = record("2026-10-09", { sleepSeconds: 27045 });
    expect(sleepDraft(api)).toEqual({ score: "", hours: "7", minutes: "30" });
    expect(sleepPatch(sleepDraft(api), api)).toEqual({});
    expect(sleepPatch({ ...sleepDraft(api), score: "80" }, api)).toEqual({ subjectiveSleepScore: 80 });
    expect(sleepPatch({ ...sleepDraft(api), hours: "8" }, api)).toEqual({ manualSleepSeconds: 30600 });
    expect(api.fields.sleepSeconds?.value).toBe(27045);
    const manual = record("2026-10-09", { sleepSeconds: 27045, manualSleepSeconds: 0 });
    expect(sleepDraft(manual)).toEqual({ score: "", hours: "0", minutes: "0" });
    expect(sleepPatch({ score: "", hours: "", minutes: "" }, manual)).toEqual({ manualSleepSeconds: null });
    expect(sleepDraft({ ...manual, fields: { sleepSeconds: api.fields.sleepSeconds! } })).toEqual(sleepDraft(api));
  });
  it("enables saving only for valid effective changes and disables it again after reset", () => {
    const api = record("2026-10-09", { sleepSeconds: 27045 });
    const initial = sleepDraft(api);
    expect(sleepHasChanges(sleepDraft())).toBe(false);
    expect(sleepHasChanges(initial, api)).toBe(false);
    expect(sleepHasChanges({ ...initial, hours: "07", minutes: "030" }, api)).toBe(false);
    expect(sleepHasChanges({ ...initial, minutes: "60" }, api)).toBe(false);
    expect(sleepHasChanges({ ...initial, hours: "24" }, api)).toBe(false);
    expect(sleepHasChanges({ ...initial, hours: "8" }, api)).toBe(true);
    expect(sleepHasChanges({ ...initial, score: "75" }, api)).toBe(true);
    expect(sleepHasChanges(initial, api)).toBe(false);
    expect(sleepHasChanges({ score: "", hours: "0", minutes: "0" })).toBe(true);
  });
  it("resets individual fields and preserves off-step stored duration until edited", () => {
    const existing = record("2026-10-09", { subjectiveSleepScore: 80.5, manualSleepSeconds: 26865 });
    const draft = sleepDraft(existing);
    expect(sleepPatch(draft, existing)).toEqual({});
    expect(sleepPatch({ ...draft, score: "" }, existing)).toEqual({ subjectiveSleepScore: null });
    expect(sleepPatch({ ...draft, hours: "", minutes: "" }, existing)).toEqual({ manualSleepSeconds: null });
    expect(sleepPatch({ ...draft, hours: "8", minutes: "15" }, existing)).toEqual({ manualSleepSeconds: 29700 });
  });
  it("writes only edited manual fields and keeps zeros as valid values", () => {
    expect(sleepPatch({ score: "0", hours: "0", minutes: "0" })).toEqual({ subjectiveSleepScore: 0, manualSleepSeconds: 0 });
    const existing = record("2026-10-09", { subjectiveSleepScore: 80, manualSleepSeconds: 27000, sleepScore: 90 });
    expect(sleepDraft(existing)).toEqual({ score: "80", hours: "7", minutes: "30" });
    expect(sleepPatch({ score: "75", hours: "7", minutes: "30" }, existing)).toEqual({ subjectiveSleepScore: 75 });
    expect(sleepPatch(sleepDraft(existing), existing)).toEqual({});
    expect(sleepPatch({ score: "", hours: "", minutes: "" }, existing)).toEqual({ subjectiveSleepScore: null, manualSleepSeconds: null });
  });
  it("allows either score or duration, and preserves sub-minute stored precision when duration is untouched", () => {
    expect(sleepPatch({ score: "80", hours: "", minutes: "" })).toEqual({ subjectiveSleepScore: 80 });
    expect(sleepPatch({ score: "", hours: "", minutes: "30" })).toEqual({ manualSleepSeconds: 1800 });
    expect(sleepPatch({ score: "", hours: "24", minutes: "0" })).toEqual({ manualSleepSeconds: 86400 });
    const existing = record("2026-10-09", { manualSleepSeconds: 27045 });
    expect(sleepPatch({ ...sleepDraft(existing), score: "85" }, existing)).toEqual({ subjectiveSleepScore: 85 });
  });
  it.each(["-1", "101", "NaN", "Infinity"])("rejects invalid scores (%s)", (score) => {
    expect(() => sleepPatch({ score, hours: "", minutes: "" })).toThrow("0 to 100");
  });
  it.each([["24", "1"], ["25", "0"], ["7", "60"], ["-1", "0"], ["7.5", "0"], ["NaN", "0"]])("rejects invalid durations (%s:%s)", (hours, minutes) => {
    expect(() => sleepPatch({ score: "", hours, minutes })).toThrow("0 and 24");
  });
  it("rejects an empty new record without substituting zeros", () => {
    expect(sleepDraft()).toEqual({ score: "", hours: "", minutes: "" });
    expect(() => sleepPatch(sleepDraft())).toThrow("score or duration");
  });
});

describe("sleep duration controls", () => {
  function controls(value: string, unit: "hours" | "minutes" = "hours", disabled = false) {
    const onChange = vi.fn();
    for (let index = 0; index < 3; index++) vi.mocked(useRef).mockImplementationOnce((initial) => ({ current: initial }));
    vi.mocked(useEffect).mockImplementationOnce(() => {}).mockImplementationOnce(() => {});
    const element = SleepDurationInput({ unit, value, disabled, onChange });
    const label = element.props.children[0] as ReactElement<{ children: ReactElement[] }>;
    const input = label.props.children[1] as ReactElement<ComponentProps<"input">>;
    const stepper = element.props.children[1] as ReactElement<{ children: ReactElement<ComponentProps<"button">>[] }>;
    return { onChange, input: input.props, buttons: stepper.props.children.map((button) => button.props) };
  }
  it("steps hours by one and minutes by five, handles empty values, and clamps at boundaries", () => {
    for (const [value, unit, expectedUp, expectedDown] of [["7", "hours", "8", "6"], ["35", "minutes", "40", "30"], ["", "hours", "1", "0"], ["", "minutes", "5", "0"], ["24", "hours", "24", "23"], ["59", "minutes", "59", "54"], ["57", "minutes", "59", "52"], ["2", "minutes", "7", "0"], ["0", "hours", "1", "0"]] as const) {
      for (const [index, expected] of [[0, expectedUp], [1, expectedDown]] as const) {
        const control = controls(value, unit);
        control.buttons[index]!.onClick!({ detail: 0 } as Parameters<NonNullable<ComponentProps<"button">["onClick"]>>[0]);
        if (expected === value) expect(control.onChange).not.toHaveBeenCalled();
        else expect(control.onChange).toHaveBeenLastCalledWith(expected);
      }
    }
    expect(controls("24").buttons[0]!.disabled).toBe(true);
    expect(controls("59", "minutes").buttons[0]!.disabled).toBe(true);
    expect(controls("0").buttons[1]!.disabled).toBe(true);
  });
  it.each(["onPointerUp", "onPointerLeave", "onPointerCancel", "onLostPointerCapture", "onBlur"] as const)("repeats while held and stops on %s without an extra release click", (stopEvent) => {
    vi.useFakeTimers();
    try {
      const control = controls("20", "minutes");
      const button = control.buttons[0]!;
      button.onPointerDown!({ isPrimary: true, button: 0, pointerId: 1, currentTarget: { setPointerCapture: vi.fn() } } as unknown as Parameters<NonNullable<typeof button.onPointerDown>>[0]);
      expect(control.onChange).toHaveBeenLastCalledWith("25");
      vi.advanceTimersByTime(399);
      expect(control.onChange).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(201);
      expect(control.onChange.mock.calls.map(([value]) => value)).toEqual(["25", "30", "35", "40"]);
      button[stopEvent]!({} as never);
      button.onClick!({ detail: 1 } as Parameters<NonNullable<typeof button.onClick>>[0]);
      vi.advanceTimersByTime(1000);
      expect(control.onChange).toHaveBeenCalledTimes(4);
    } finally { vi.useRealTimers(); }
  });
  it("stops repeating at the limit and ignores disabled buttons", () => {
    vi.useFakeTimers();
    try {
      for (const disabled of [false, true]) {
        const control = controls("54", "minutes", disabled);
        control.buttons[0]!.onPointerDown!({ isPrimary: true, button: 0, pointerId: 1, currentTarget: { setPointerCapture: vi.fn() } } as unknown as Parameters<NonNullable<ComponentProps<"button">["onPointerDown"]>>[0]);
        vi.advanceTimersByTime(2000);
        expect(control.onChange).toHaveBeenCalledTimes(disabled ? 0 : 1);
        if (!disabled) expect(control.onChange).toHaveBeenLastCalledWith("59");
        expect(vi.getTimerCount()).toBe(0);
      }
    } finally { vi.useRealTimers(); }
  });
  it("preserves direct input and disables all controls while busy", () => {
    const control = controls("7");
    control.input.onChange!({ target: { value: "" } } as Parameters<NonNullable<typeof control.input.onChange>>[0]);
    expect(control.onChange).toHaveBeenLastCalledWith("");
    const busy = controls("7", "hours", true);
    expect(busy.input.disabled).toBe(true);
    expect(busy.buttons.every((button) => button.disabled)).toBe(true);
    expect(control.buttons.map((button) => button["aria-label"])).toEqual(["Increase · Hours", "Decrease · Hours"]);
    vi.stubGlobal("localStorage", { getItem: () => "zh-CN", setItem: () => {} });
    try {
      const html = renderToStaticMarkup(createElement(LanguageProvider, null, createElement(SleepDurationInput, { unit: "minutes", value: "35", disabled: false, onChange: vi.fn() })));
      expect(html).toContain('aria-label="增加 · 分钟"');
      expect(html).toContain('aria-label="减少 · 分钟"');
    } finally {
      vi.stubGlobal("localStorage", { getItem: () => "en", setItem: () => {} });
      renderToStaticMarkup(createElement(LanguageProvider, null, createElement("span")));
      vi.unstubAllGlobals();
    }
  });
});

describe("sleep sliders", () => {
  const props = { label: "Sleep time", value: null, max: 1440, step: 15, valueLabel: "Not recorded", disabled: false, onChange: vi.fn(), onReset: vi.fn() };
  it("shows confirmation in the existing reset button without clearing the displayed value", () => {
    const html = renderToStaticMarkup(createElement(SleepSlider, { ...props, value: 495, valueLabel: "8 Hours 15 Minutes", confirmReset: true }));
    expect(html).toContain('aria-label="Confirm reset · Sleep time"');
    expect(html).toContain(">Confirm reset</button>");
    expect(html).toContain("<output>8 Hours 15 Minutes</output>");
    expect(html).toContain('value="495"');
    expect(html.match(/<button/g)).toHaveLength(1);
  });
  it("renders optional, accessible native sliders with range limits and selected values", () => {
    const empty = renderToStaticMarkup(createElement(SleepSlider, props));
    expect(empty).toContain('<output class="not-recorded">Not recorded</output>');
    expect(empty).toContain('type="range"');
    expect(empty).toContain('max="1440" step="15"');
    expect(empty).toContain('disabled="" aria-label="Reset · Sleep time"');
    const selected = renderToStaticMarkup(createElement(SleepSlider, { ...props, value: 495, valueLabel: "8 Hours 15 Minutes" }));
    expect(selected).toContain('aria-valuetext="8 Hours 15 Minutes"');
    expect(selected).toContain('value="495"');
    expect(selected).not.toContain('class="not-recorded"');
    expect(renderToStaticMarkup(createElement(SleepSlider, { ...props, value: 0, valueLabel: "0 Hours 0 Minutes" }))).not.toContain('disabled=""');
  });
  it("updates selected values and allows pointer or keyboard selection of an initial zero", () => {
    const onChange = vi.fn();
    const element = SleepSlider({ ...props, onChange });
    const input = (element.props.children[1] as ReactElement<ComponentProps<"input">>).props;
    input.onChange!({ target: { value: "495" } } as Parameters<NonNullable<typeof input.onChange>>[0]);
    expect(onChange).toHaveBeenLastCalledWith(495);
    input.onPointerUp!({ currentTarget: { value: "0" } } as Parameters<NonNullable<typeof input.onPointerUp>>[0]);
    expect(onChange).toHaveBeenLastCalledWith(0);
    input.onKeyUp!({ key: "Home", currentTarget: { value: "0" } } as Parameters<NonNullable<typeof input.onKeyUp>>[0]);
    expect(onChange).toHaveBeenLastCalledWith(0);
    onChange.mockClear();
    input.onKeyUp!({ key: "Tab", currentTarget: { value: "0" } } as Parameters<NonNullable<typeof input.onKeyUp>>[0]);
    expect(onChange).not.toHaveBeenCalled();
  });
});


describe("sleep evening dates", () => {
  it.each([["2026-10-09", "2026-10-08"], ["2026-01-01", "2025-12-31"], ["2026-11-01", "2026-10-31"], ["2024-03-01", "2024-02-29"]])("projects %s sleep to %s without moving heart data", (wake, evening) => {
    const raw = [record(wake, { sleepSeconds: 28800, manualSleepSeconds: 27000, sleepScore: 80, subjectiveSleepScore: 90, sleepQuality: 1, avgSleepingHeartRateBpm: 45, hrvRmssdMs: 60, restingHeartRateBpm: 50 })];
    const before = structuredClone(raw);
    const projected = eveningWellnessRecords(raw);
    expect(projected.find((item) => item.day === evening)?.fields).toEqual(Object.fromEntries(Object.entries(raw[0]!.fields).filter(([key]) => key !== "hrvRmssdMs" && key !== "restingHeartRateBpm")));
    expect(projected.find((item) => item.day === wake)?.fields).toEqual({ hrvRmssdMs: raw[0]!.fields.hrvRmssdMs, restingHeartRateBpm: raw[0]!.fields.restingHeartRateBpm });
    expect(sleepStorageDay(evening)).toBe(wake);
    expect(raw).toEqual(before);
    expect(eveningWellnessRecords(raw)).toEqual(projected);
  });
  it("includes the next morning at the last evening in a chart window and excludes the prior night", () => {
    const raw = [record("2026-10-03", { sleepScore: 10 }), record("2026-10-04", { sleepScore: 20 }), record("2026-10-10", { sleepScore: 30 })];
    const chart = wellnessSeries(raw, scoreMetric, "2026-10-03", "2026-10-09");
    expect(chart.series[0]!.points.map(({ day, value }) => [day, value])).toEqual([["2026-10-03", 20], ["2026-10-09", 30]]);
  });
  it("merges sleep with the evening's health data while isolating owners", () => {
    const raw = [record("2026-10-08", { hrvRmssdMs: 60 }), record("2026-10-09", { sleepScore: 80 }), { ...record("2026-10-09", { sleepScore: 20 }), ownerId: "other" }];
    expect(eveningWellnessRecords(raw).find((item) => item.day === "2026-10-08" && item.ownerId === "local-user")?.fields).toEqual({ hrvRmssdMs: raw[0]!.fields.hrvRmssdMs, sleepScore: raw[1]!.fields.sleepScore });
  });
});
