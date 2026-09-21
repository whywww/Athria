import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChangePasswordModal, RequirePasswordModal } from "./App";

type Overrides = { value?: { currentPassword: string; password: string; confirmation: string }; error?: unknown; busy?: boolean };

function render(overrides: Overrides = {}): string {
  return renderToStaticMarkup(createElement(ChangePasswordModal, {
    value: overrides.value ?? { currentPassword: "", password: "", confirmation: "" },
    error: overrides.error,
    busy: overrides.busy ?? false,
    onChange: () => {},
    onClose: () => {},
    onSubmit: () => {},
  }));
}

describe("ChangePasswordModal", () => {
  it("wires the dialog to its title and explains the password change", () => {
    const html = render();
    expect(html).toContain('role="dialog" aria-modal="true" aria-labelledby="change-password-title"');
    expect(html).toContain('<h2 id="change-password-title">Change Database Password</h2>');
    expect(html).toContain("This re-wraps the database master key; your saved connection keys do not need to be entered again.");
  });

  it("renders the current password and two new-password fields", () => {
    const html = render();
    expect((html.match(/type="password"/g) ?? []).length).toBe(3);
    expect((html.match(/autocomplete="new-password"/gi) ?? []).length).toBe(2);
    expect(html).toMatch(/autocomplete="current-password"/i);
    expect(html).toContain('autofocus=""');
  });

  it("flags mismatching passwords and disables the submit button", () => {
    const html = render({ value: { currentPassword: "old password", password: "correct horse", confirmation: "correct hors" } });
    expect(html).toContain('class="invalid"');
    expect(html).toContain("Passwords do not match.");
    expect(html).toMatch(/<button type="button" disabled="">Change Password<\/button>/);
  });

  it("keeps an empty draft disabled and enables the submit button once the passwords match", () => {
    expect(render()).toMatch(/<button type="button" disabled="">Change Password<\/button>/);
    const valid = render({ value: { currentPassword: "old password", password: "correct horse battery", confirmation: "correct horse battery" } });
    expect(valid).not.toContain('class="invalid"');
    expect(valid).not.toContain("Passwords do not match.");
    expect(valid).toMatch(/<button type="button">Change Password<\/button>/);
  });

  it("shows the busy label and disables both actions while changing", () => {
    const html = render({ value: { currentPassword: "old password", password: "correct horse battery", confirmation: "correct horse battery" }, busy: true });
    expect(html).toContain("Changing Password…");
    expect(html).toMatch(/<button type="button" class="secondary" disabled="">Cancel<\/button>/);
    expect(html).toMatch(/<button type="button" disabled="">Changing Password…<\/button>/);
  });

  it("renders failures through the banner", () => {
    expect(render()).not.toContain('role="alert"');
    const html = render({ error: new Error("The database is locked.") });
    expect(html).toContain('class="error" role="alert"');
    expect(html).toContain("The database is locked.");
  });

  it("offers an explicit close control on the password dialogs", () => {
    for (const html of [render(), renderToStaticMarkup(createElement(RequirePasswordModal, { value: "", error: undefined, busy: false, onChange: () => {}, onClose: () => {}, onSubmit: () => {} }))]) {
      expect(html).toContain('class="modal-close"');
      expect(html).toContain('aria-label="Close dialog"');
    }
  });
});
