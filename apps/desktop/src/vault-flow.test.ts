import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient } from "@tanstack/query-core";
import { QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { changeVaultPassword, createNewProfile, requireVaultPassword, setupVault } from "./api";
import { DatabaseGate, DatabaseSwitchModal, NewProfileModal } from "./App";

function renderGate(initialized: boolean, locked: boolean) {
  const client = new QueryClient();
  client.setQueryData(["vault-status"], { databaseUuid: "database-id", databasePath: "C:\\profiles\\active.sqlite3", initialized, locked, remembered: false, legacySources: [] });
  return renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(DatabaseGate)));
}

describe("database password flow", () => {
  beforeEach(() => invoke.mockReset());

  it("remembers by default during setup but not while unlocking a database", () => {
    expect(renderGate(false, false)).toMatch(/type="checkbox"[^>]*checked=""/);
    expect(renderGate(true, true)).toMatch(/type="checkbox"(?![^>]*checked)/);
  });

  it("identifies the database file whose password is being set", () => {
    const html = renderGate(false, false);
    expect(html).toContain('<h2 id="database-gate-title">Set Database Password</h2>');
    expect(html).toContain('<div class="gate-database-location"><span>Database</span>');
    expect(html).toContain('<code title="C:\\profiles\\active.sqlite3">C:\\profiles\\active.sqlite3</code>');
    expect(html).toContain("Switch database");
  });

  it("uses the dedicated gate layout for setup and unlock states", () => {
    const setup = renderGate(false, false);
    const unlock = renderGate(true, true);
    expect(setup).toContain('class="connection-modal database-gate"');
    expect(setup).toContain('class="gate-fields"');
    expect((setup.match(/type="password"/g) ?? []).length).toBe(2);
    expect(unlock).toContain('<h2 id="database-gate-title">Unlock this database</h2>');
    expect((unlock.match(/type="password"/g) ?? []).length).toBe(1);
    expect(unlock).toContain("Forgot password?");
  });

  it("passes the remember choice when setting up the vault", async () => {
    await setupVault("secret", false);
    expect(invoke).toHaveBeenCalledWith("setup_vault", { password: "secret", remember: false });
  });

  it("passes the current password for protected password-setting operations", async () => {
    await changeVaultPassword("new secret", "current secret");
    expect(invoke).toHaveBeenCalledWith("change_vault_password", { currentPassword: "current secret", newPassword: "new secret" });
    await requireVaultPassword("current secret");
    expect(invoke).toHaveBeenCalledWith("require_vault_password", { currentPassword: "current secret" });
  });

  it("creates a profile using only its selected path", async () => {
    await createNewProfile("C:\\profiles\\fresh.sqlite3");
    expect(invoke).toHaveBeenCalledWith("create_new_profile", { path: "C:\\profiles\\fresh.sqlite3" });
  });

  it("does not request a password in the new-profile confirmation", () => {
    const html = renderToStaticMarkup(createElement(NewProfileModal, { target: "C:\\profiles\\fresh.sqlite3", error: undefined, busy: false, onClose: () => undefined, onSubmit: () => undefined }));
    expect(html).not.toContain('type="password"');
    expect(html).toContain("You will set its database password when it opens.");
    expect(html).toContain("Create Profile");
    expect(html).toContain('class="modal-close"');
    expect(html).toContain('aria-label="Close dialog"');
  });

  it("renders database switching as a dedicated confirmation dialog", () => {
    const html = renderToStaticMarkup(createElement(DatabaseSwitchModal, {
      preview: { path: "C:\\profiles\\backup.sqlite3", counts: { workouts: 12, templates: 3, plans: 2 }, includesCredentials: false },
      error: undefined,
      busy: false,
      onClose: () => undefined,
      onSubmit: () => undefined,
    }));
    expect(html).toContain('<h2 id="database-switch-title">Switch to this database?</h2>');
    expect(html).toContain('aria-labelledby="database-switch-title"');
    expect(html).toContain("C:\\profiles\\backup.sqlite3");
    expect(html).toContain("12</b><small>workouts");
    expect(html).toContain("3</b><small>templates");
    expect(html).toContain("2</b><small>plans");
    expect(html).toContain("Switch database");
    expect(html).toContain('class="modal-close"');
    expect(html).toContain('aria-label="Close dialog"');
    expect(html).not.toContain("Database password");
    expect(html).not.toContain("Unlock this database");
  });
});
