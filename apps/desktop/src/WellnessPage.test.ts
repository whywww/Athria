import { type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WellnessRecord } from "./view-models";

const harness = vi.hoisted(() => ({ states: [] as unknown[], cursor: 0, effects: [] as (() => void)[], records: new Map<string, { record?: WellnessRecord; snapshotHash: string }>(), query: null as null | { queryKey: string[]; queryFn: () => Promise<unknown>; enabled: boolean }, invalidateQueries: vi.fn(), refetch: vi.fn(), api: vi.fn() }));
vi.mock("react", async (importOriginal) => {
  const original = await importOriginal<typeof import("react")>();
  return { ...original,
    useState: (initial: unknown) => {
      const index = harness.cursor++;
      if (!(index in harness.states)) harness.states[index] = initial;
      return [harness.states[index], (next: unknown) => { harness.states[index] = typeof next === "function" ? next(harness.states[index]) : next; }];
    },
    useEffect: (effect: () => void) => { harness.effects.push(effect); },
  };
});
vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: NonNullable<typeof harness.query>) => {
    harness.query = options;
    return { data: harness.records.get(options.queryKey.at(-1)!), isPending: false, isFetching: false, error: null, refetch: harness.refetch };
  },
  useQueryClient: () => ({ invalidateQueries: harness.invalidateQueries }),
}));
vi.mock("./api", () => ({ api: harness.api }));
vi.mock("./components", () => ({ useModalDismiss: vi.fn(), ErrorBanner: () => null, Loading: () => null }));
import { HealthRecordModal, SleepSlider } from "./WellnessPage";

function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as ReactElement<Record<string, unknown>>;
  return [element, ...elements(element.props.children as ReactNode)];
}
const field = (value: number, source: "user" | "intervals_icu" = "user") => ({ value, source, updatedAt: "2026-10-09T08:00:00Z" });
const record: WellnessRecord = { ownerId: "local-user", day: "2026-10-09", fields: { subjectiveSleepScore: field(90), manualSleepSeconds: field(28800), sleepScore: field(80, "intervals_icu"), sleepSeconds: field(27000, "intervals_icu"), hrvRmssdMs: field(60, "intervals_icu") }, updatedAt: "2026-10-09T08:00:00Z" };

describe("manual sleep evening records", () => {
  const onClose = vi.fn();
  function render() {
    harness.cursor = 0; harness.effects = [];
    const tree = HealthRecordModal({ today: "2026-10-09", databaseUuid: "database", onClose });
    for (const effect of harness.effects) effect();
    return elements(tree);
  }
  function control(nodes: ReturnType<typeof render>, predicate: (element: ReactElement<Record<string, unknown>>) => boolean) { return nodes.find(predicate)!.props; }
  function initialized() { render(); return render(); }
  async function submit(nodes: ReturnType<typeof render>) {
    (control(nodes, (element) => element.type === "form").onSubmit as (event: unknown) => void)({ preventDefault: vi.fn() });
    await vi.waitFor(() => expect(harness.api).toHaveBeenCalled());
  }
  beforeEach(() => {
    vi.clearAllMocks(); harness.states = []; harness.records.clear(); harness.query = null;
    harness.records.set("2026-10-09", { record: structuredClone(record), snapshotHash: "original" });
    harness.api.mockResolvedValue({}); harness.invalidateQueries.mockResolvedValue(undefined);
  });
  it("defaults to yesterday and reads the next day's raw record with its snapshot", async () => {
    const nodes = initialized();
    expect(control(nodes, (element) => element.type === "input" && element.props.type === "date")).toMatchObject({ value: "2026-10-08", max: "2026-10-09" });
    expect(harness.query?.queryKey).toEqual(["wellness", "day", "database", "2026-10-09"]);
    await harness.query!.queryFn();
    expect(harness.api).toHaveBeenCalledWith("/api/wellness/2026-10-09");
    expect(control(nodes, (element) => element.type === SleepSlider).value).toBe(90);
    expect(nodes.some((element) => element.props.children === "Record date")).toBe(true);
  });
  it("saves to the next day using the raw snapshot without touching HRV or device sleep", async () => {
    let nodes = initialized();
    (control(nodes, (element) => element.type === SleepSlider).onChange as (value: number) => void)(95);
    nodes = render(); await submit(nodes);
    const [path, options] = harness.api.mock.calls[0]!;
    expect(path).toBe("/api/wellness/2026-10-09");
    expect(JSON.parse(options.body)).toEqual({ confirmed: true, source: "user", expectedSnapshotHash: "original", fields: { subjectiveSleepScore: 95 } });
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(harness.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["wellness"] });
  });
  it("maps a changed evening across a year boundary and loads that day's baseline", () => {
    let nodes = initialized();
    harness.records.set("2026-01-01", { record: { ...record, day: "2026-01-01", fields: { sleepScore: field(70, "intervals_icu") } }, snapshotHash: "january" });
    (control(nodes, (element) => element.type === "input" && element.props.type === "date").onChange as (event: unknown) => void)({ target: { value: "2025-12-31" } });
    render(); nodes = render();
    expect(harness.query?.queryKey.at(-1)).toBe("2026-01-01");
    expect(control(nodes, (element) => element.type === SleepSlider).value).toBe(70);
  });
  it("resets the manual score to the device value and clears only the mapped override", async () => {
    let nodes = initialized();
    (control(nodes, (element) => element.type === SleepSlider).onReset as () => void)(); nodes = render();
    expect(control(nodes, (element) => element.type === SleepSlider).confirmReset).toBe(true);
    (control(nodes, (element) => element.type === SleepSlider).onReset as () => void)(); nodes = render();
    expect(control(nodes, (element) => element.type === SleepSlider).value).toBe(80);
    await submit(nodes);
    expect(JSON.parse(harness.api.mock.calls[0]![1].body).fields).toEqual({ subjectiveSleepScore: null });
  });
  it("reloads the mapped day's snapshot after conflict while keeping the edited score", async () => {
    let nodes = initialized();
    (control(nodes, (element) => element.type === SleepSlider).onChange as (value: number) => void)(95);
    harness.api.mockRejectedValueOnce(new Error("INPUT_SNAPSHOT_CHANGED"));
    await submit(render());
    await vi.waitFor(() => expect(harness.states[4]).toBe(true));
    expect(onClose).not.toHaveBeenCalled();
    harness.refetch.mockResolvedValue({ data: { record, snapshotHash: "refreshed" }, error: null });
    nodes = render();
    await (control(nodes, (element) => element.type === "button" && elements(element.props.children as ReactNode).some((child) => child.props.children === "Reload latest data")).onClick as () => Promise<void>)();
    nodes = render();
    expect(control(nodes, (element) => element.type === SleepSlider).value).toBe(95);
    await submit(nodes);
    expect(JSON.parse(harness.api.mock.calls.at(-1)![1].body).expectedSnapshotHash).toBe("refreshed");
  });
});
