// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { api } from "./api";
import { TimelineWorkout } from "./App";
import { LanguageProvider } from "./i18n";
import type { CalendarSession, TrainingHistorySession } from "./view-models";

vi.mock("./api", async (importOriginal) => ({ ...await importOriginal<typeof import("./api")>(), api: vi.fn() }));

const mocked = vi.mocked(api);

const item: TrainingHistorySession = { id: "workout-1", name: "Morning Swim", startAt: "2026-10-12T10:00:00Z", timezone: "UTC", domains: ["endurance"], type: "Swimming", subtype: null, durationMinutes: 30, timePrecision: "exact", snapshotHash: "hash-1", sources: [{ source: "intervals", externalId: "i1" }], plannedSessionId: "plan-1", planMatch: { plannedSessionId: "plan-1", method: "auto" }, isPlanMatchExcluded: false };
const planned = [
  { id: "plan-1", scheduledDate: "2026-10-12", name: "Swim", status: "planned", type: "Swimming", domain: "endurance", prescription: null, completedTrainingSessionId: "workout-1" },
  { id: "plan-2", scheduledDate: "2026-10-12", name: "Easy Swim", status: "planned", type: "Swimming", domain: "endurance", prescription: null, completedTrainingSessionId: null },
] as unknown as CalendarSession[];

let container: HTMLDivElement;
let root: Root;
let onMutated: Mock<() => Promise<void>>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocked.mockReset();
  onMutated = vi.fn(async () => {});
  container = document.createElement("div"); document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

async function mount() {
  await act(async () => root.render(createElement(LanguageProvider, null, createElement(TimelineWorkout, { item, planned, revision: 30, timezone: "UTC", onMutated }))));
  return container.querySelector("select")!;
}
async function choose(select: HTMLSelectElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select, value);
    select.dispatchEvent(new Event("input", { bubbles: true }));
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

describe("Planned session menu", () => {
  it("clears the match when the dash option is chosen", async () => {
    mocked.mockResolvedValue({} as never);
    const select = await mount();
    await choose(select, "");
    expect(mocked).toHaveBeenCalledOnce();
    const [path, init] = mocked.mock.calls[0]!;
    expect(path).toBe("/api/training-sessions/workout-1/plan-match");
    expect(init?.method).toBe("PATCH");
    expect(JSON.parse(String(init?.body))).toEqual({ plannedSessionId: null, expectedRevision: 30, confirmed: true, expectedSnapshotHash: "hash-1" });
    expect(onMutated).toHaveBeenCalledTimes(1);
  });
  it("still links an ordinary planned session", async () => {
    mocked.mockResolvedValue({} as never);
    const select = await mount();
    await choose(select, "plan-2");
    expect(mocked).toHaveBeenCalledOnce();
    const [, init] = mocked.mock.calls[0]!;
    expect(JSON.parse(String(init?.body))).toEqual({ plannedSessionId: "plan-2", expectedRevision: 30, confirmed: true, expectedSnapshotHash: "hash-1" });
    expect(onMutated).toHaveBeenCalledTimes(1);
  });
});
