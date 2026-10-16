// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TrainingEffort } from "./training-effort";
import { LanguageProvider } from "./i18n";

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div"); document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

async function mount(rpe: number | null = 3, onSave = vi.fn(async (_value: number) => true), disabled = false) {
  await act(async () => root.render(createElement(TrainingEffort, { rpe, name: "Run", disabled, onSave })));
  const slider = container.querySelector("input")!;
  const button = container.querySelector("button")!;
  return { slider, button, onSave };
}
async function change(slider: HTMLInputElement, value: number) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(slider, String(value));
    slider.dispatchEvent(new Event("input", { bubbles: true }));
    slider.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
async function release(slider: HTMLInputElement) {
  await act(async () => slider.dispatchEvent(new PointerEvent("pointerup", { bubbles: true })));
}

describe("Effort slider", () => {
  it("uses a native auto popover for exclusive opening, outside dismissal, Escape and the top layer", async () => {
    const { button, onSave } = await mount(null);
    await act(async () => button.click());
    const popover = container.querySelector('[popover="auto"]')!;
    expect(button.getAttribute("popovertarget")).toBe(popover.id);
    expect(container.querySelector("input")!.min).toBe("1");
    expect(container.querySelector("input")!.max).toBe("10");
    expect(container.querySelector("input")!.step).toBe("1");
    expect(button.textContent).toBe("-");
    expect(onSave).not.toHaveBeenCalled();
  });
  it("previews during dragging and saves once on release", async () => {
    const { slider, button, onSave } = await mount();
    await change(slider, 7);
    expect(button.textContent).toBe("7");
    expect(onSave).not.toHaveBeenCalled();
    await release(slider);
    expect(onSave).toHaveBeenCalledExactlyOnceWith(7);
    await release(slider);
    expect(onSave).toHaveBeenCalledTimes(1);
  });
  it("anchors below the number and follows the page scroll", async () => {
    const { button } = await mount();
    const popover = container.querySelector<HTMLElement>(".training-effort-popover")!;
    const rect = (top: number) => ({ left: 100, right: 120, top, bottom: top + 20, width: 20, height: 20, x: 100, y: top, toJSON: () => ({}) }) as DOMRect;
    button.getBoundingClientRect = () => rect(200);
    await act(async () => button.click());
    expect(popover.style.left).toBe("60px");
    expect(popover.style.top).toBe("220px");
    button.getBoundingClientRect = () => rect(150);
    await act(async () => window.dispatchEvent(new Event("scroll")));
    expect(popover.style.left).toBe("60px");
    expect(popover.style.top).toBe("170px");
    button.getBoundingClientRect = () => rect(760);
    await act(async () => window.dispatchEvent(new Event("scroll")));
    expect(popover.style.top).toBe("744px");
  });
  it("does not write an unchanged value, and allows selecting 1 for missing RPE", async () => {
    const { slider, onSave } = await mount();
    await release(slider);
    await change(slider, 4); await change(slider, 3); await release(slider);
    expect(onSave).not.toHaveBeenCalled();
    const missing = await mount(null, onSave);
    await act(async () => missing.button.click());
    await release(missing.slider);
    expect(onSave).toHaveBeenCalledExactlyOnceWith(1);
  });
  it("commits keyboard changes on key release", async () => {
    const { slider, onSave } = await mount();
    await change(slider, 4);
    await act(async () => slider.dispatchEvent(new KeyboardEvent("keyup", { key: "ArrowRight", bubbles: true })));
    expect(onSave).toHaveBeenCalledExactlyOnceWith(4);
  });
  it("restores the saved value after failure and allows retry", async () => {
    const onSave = vi.fn(async (_value: number) => false);
    const { slider } = await mount(3, onSave);
    await change(slider, 8); await release(slider);
    expect(slider.value).toBe("3");
    await change(slider, 7); await release(slider);
    expect(onSave.mock.calls).toEqual([[8], [7]]);
  });
  it("blocks duplicate saves while a request is pending", async () => {
    let finish!: (value: boolean) => void;
    const onSave = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    const { slider } = await mount(3, onSave);
    await change(slider, 6); await release(slider);
    await release(slider);
    expect(onSave).toHaveBeenCalledTimes(1);
    await act(async () => finish(true));
  });
  it("disables editing while the row is busy", async () => {
    const { button, slider, onSave } = await mount(3, undefined, true);
    expect(button.disabled).toBe(true); expect(slider.disabled).toBe(true);
    await change(slider, 7); await release(slider);
    expect(onSave).not.toHaveBeenCalled();
  });
  it("translates the editor into Chinese", async () => {
    localStorage.setItem("athria:language", "zh-CN");
    await act(async () => root.render(createElement(LanguageProvider, null, createElement(TrainingEffort, { rpe: 7, name: "Run", disabled: false, onSave: async () => true }))));
    expect(container.querySelector("input")!.getAttribute("aria-label")).toBe("强度: Run");
    expect(container.querySelector("button")!.getAttribute("aria-label")).toBe("修改强度: Run");
    localStorage.removeItem("athria:language");
  });
});
