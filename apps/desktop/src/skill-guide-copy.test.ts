import { type ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SkillArchiveGuideModal } from "./App";

const harness = vi.hoisted(() => ({ states: [] as unknown[], cursor: 0, language: "en" as "en" | "zh-CN" }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = harness.cursor++;
    if (!(index in harness.states)) harness.states[index] = initial;
    return [harness.states[index], (value: unknown) => { harness.states[index] = value; }];
  },
}));
vi.mock("./components", async (original) => ({ ...await original<typeof import("./components")>(), useModalDismiss: () => {} }));
vi.mock("./toasts", async (original) => ({ ...await original<typeof import("./toasts")>(), useOperationError: () => [undefined, vi.fn()] }));
vi.mock("./i18n", async (original) => {
  const actual = await original<typeof import("./i18n")>();
  return { ...actual, tr: (text: string) => actual.translate(text, harness.language) };
});

type Node = ReactElement<{ children?: unknown; className?: string; role?: string; onClick?: () => Promise<void> }>;
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const node = value as Node;
  return [node, ...nodes(node.props.children)];
}
function guide() {
  harness.cursor = 0;
  return nodes(SkillArchiveGuideModal({ guide: { name: "Claude Desktop", archives: [], updating: false }, onClose: () => {} }));
}
afterEach(() => { harness.states = []; harness.language = "en"; vi.unstubAllGlobals(); });

describe("Skill guide prompt copying", () => {
  it.each(["en", "zh-CN"] as const)("copies the visible %s prompt and confirms success", async (language) => {
    harness.language = language;
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const tree = guide();
    const prompt = tree.find((node) => node.props.className === "agent-load-prompt")!.props.children;
    await tree.find((node) => node.props.onClick && node.props.className === "secondary compact")!.props.onClick!();
    expect(writeText).toHaveBeenCalledWith(prompt);
    expect(prompt).toContain(language === "en" ? "do not modify my data" : "不修改我的数据");
    expect(guide().some((node) => node.props.role === "status")).toBe(true);
    expect(guide().find((node) => node.props.className === "secondary compact")!.props.children).toBe(language === "en" ? "Copied" : "已复制");
  });

  it("keeps the prompt visible on failure and clears the error after retry", async () => {
    const writeText = vi.fn().mockRejectedValueOnce(new Error("clipboard denied")).mockResolvedValueOnce(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    await guide().find((node) => node.props.className === "secondary compact")!.props.onClick!();
    const failed = guide();
    expect(failed.some((node) => node.props.role === "alert")).toBe(true);
    expect(failed.some((node) => node.props.className === "agent-load-prompt")).toBe(true);
    await failed.find((node) => node.props.className === "secondary compact")!.props.onClick!();
    expect(guide().some((node) => node.props.role === "alert")).toBe(false);
    expect(guide().some((node) => node.props.role === "status")).toBe(true);
  });
});
