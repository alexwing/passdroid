// What the current platform can do. The desktop and Android apps keep every
// capability (the defaults below), so nothing changes for them. Passdroid Web
// (the zero-knowledge web client in the separate passdroidWeb repo) reuses
// this UI with the Tauri modules swapped for a web backend, and turns off what
// makes no sense in a browser by setting `globalThis.__PASSDROID_PLATFORM__`
// BEFORE the app is imported (see passdroidWeb/web/src/main.tsx).
//
// Why each one is off on the web:
// - localFiles: the vault lives on the server; there are no file pickers.
// - ftpSync / qrLink: FTP sync and device linking are desktop/Android
//   features; the QR carries the FTP password and must never be shown in a
//   browser. The web saves to the server automatically.
// - createVault, importLegacy, exportFiles, vaultIcon: out of scope for web v1
//   (PLAN §4); the encrypted copy download comes in v1.1.
// - changeMasterPassword is on for the web: the shell re-keys the vault in the
//   crypto worker and saves it to the server (other sessions see the new salt
//   and ask for the new password).
// - titleBar: the custom desktop title bar.
// - qrShare is the exception: the web shell turns it on, so the settings can show
//   a QR that links a phone to this vault (the server fetches the FTP config
//   when the user asks for it, see App.tsx).

import { useSyncExternalStore } from "react";

export interface PlatformCapabilities {
  /** Running as Passdroid Web. */
  web: boolean;
  localFiles: boolean;
  ftpSync: boolean;
  qrLink: boolean;
  /** Settings show a QR that links a phone to this vault (web: the server
   *  sends the FTP config on request). Desktop has its QR in the Sync tab. */
  qrShare: boolean;
  createVault: boolean;
  importLegacy: boolean;
  exportFiles: boolean;
  changeMasterPassword: boolean;
  vaultIcon: boolean;
  titleBar: boolean;
  /** The vault is saved to the Passdroid Web server after every change
   *  (status text instead of the FTP sync state). */
  serverSync: boolean;
  /** The start screen offers "New vault", which asks the web shell to create
   *  one on the server (CREATE_SERVER_VAULT_EVENT). The shell turns it on for
   *  administrators only. */
  serverCreateVault: boolean;
}

export const DESKTOP_CAPABILITIES: PlatformCapabilities = {
  web: false,
  localFiles: true,
  ftpSync: true,
  qrLink: true,
  qrShare: false,
  createVault: true,
  importLegacy: true,
  exportFiles: true,
  changeMasterPassword: true,
  vaultIcon: true,
  titleBar: true,
  serverSync: false,
  serverCreateVault: false,
};

export const WEB_CAPABILITIES: PlatformCapabilities = {
  web: true,
  localFiles: false,
  ftpSync: false,
  qrLink: false,
  qrShare: false,
  createVault: false,
  importLegacy: false,
  exportFiles: false,
  changeMasterPassword: true,
  vaultIcon: false,
  titleBar: false,
  serverSync: true,
  serverCreateVault: false,
};

/** Name, tagline and logo of the app, set by the Passdroid Web administrator.
 *  Absent keys fall back to the built-in texts and icon. */
export interface Brand {
  name?: string;
  tagline?: string;
  logoUrl?: string;
}

declare global {
  // eslint-disable-next-line no-var
  var __PASSDROID_PLATFORM__: Partial<PlatformCapabilities> | undefined;
  // eslint-disable-next-line no-var
  var __PASSDROID_BRAND__: Brand | undefined;
}

/** Read once per call so tests can switch platforms between renders. */
export function platform(): PlatformCapabilities {
  return { ...DESKTOP_CAPABILITIES, ...(globalThis.__PASSDROID_PLATFORM__ ?? {}) };
}

/** Event the web backend dispatches on `window` when the vault changed from
 *  outside the UI (a reload or merge after another device wrote): the UI
 *  reloads its entry list. Never dispatched on desktop/Android. */
export const VAULT_CHANGED_EVENT = "passdroid:vault-changed";

/** Event the web shell dispatches on `window` to lock the vault from outside
 *  the UI (master password changed on another device, server session
 *  expired, the user chose to lock after a rollback warning): the UI runs its
 *  normal lock and returns to the unlock screen. Web only. */
export const VAULT_LOCK_EVENT = "passdroid:lock";

/** Event the UI dispatches on `window` when an administrator asks for a new
 *  vault on the server (start screen, `serverCreateVault`). The web shell shows
 *  its own dialog and does the cryptography. Web only. */
export const CREATE_SERVER_VAULT_EVENT = "passdroid:create-server-vault";

/** Event the web shell dispatches on `window` after the list of server vaults
 *  changed (an administrator created one): the start screen reloads its
 *  list. Never dispatched on desktop/Android. */
export const VAULTS_CHANGED_EVENT = "passdroid:vaults-changed";

/** Event the web shell dispatches on `window` after it replaces
 *  `globalThis.__PASSDROID_BRAND__`. Never dispatched on desktop/Android. */
export const BRAND_CHANGED_EVENT = "passdroid:brand-changed";

// Built-in brand: a constant, so brand() returns the same reference on every
// call while no brand is set (useSyncExternalStore needs that).
const NO_BRAND: Brand = {};

/** The brand the web shell set, or the built-in one (empty) when there is none. */
export function brand(): Brand {
  return globalThis.__PASSDROID_BRAND__ ?? NO_BRAND;
}

const subscribeBrand = (onChange: () => void) => {
  window.addEventListener(BRAND_CHANGED_EVENT, onChange);
  return () => window.removeEventListener(BRAND_CHANGED_EVENT, onChange);
};

/** The current brand; re-renders when the web shell announces a change. */
export function useBrand(): Brand {
  return useSyncExternalStore(subscribeBrand, brand, brand);
}
