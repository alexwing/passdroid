import { invoke } from "@tauri-apps/api/core";
import type { LanguagePreference, ThemePreference } from "./i18n";

export interface VaultEntry {
  id: string;
  title: string;
  username: string;
  password: string;
  url: string;
  notes: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
  conflict: boolean;
}

export interface VaultStatus {
  path: string;
  vaultId: string;
  revision: number;
  entryCount: number;
}

export interface Preferences {
  theme: ThemePreference;
  language: LanguagePreference;
  recentVaults: string[];
}

export interface GeneratePasswordOptions {
  length: number;
  uppercase: boolean;
  lowercase: boolean;
  numbers: boolean;
  symbols: boolean;
}

export interface ImportPreviewEntry {
  title: string;
  username: string;
  url: string;
  hasPassword: boolean;
}

export interface ImportPreview {
  importId: string;
  count: number;
  entries: ImportPreviewEntry[];
}

export interface SyncConfig {
  enabled: boolean;
  protocol: string;
  host: string;
  port: number;
  username: string;
  password: string;
  remoteDir: string;
  remoteFile: string;
}

export interface SyncResult {
  pulled: boolean;
  revision: number;
  entryCount: number;
}

const Api = {
  getPreferences: () => invoke<Preferences>("get_preferences"),
  savePreferences: (preferences: Preferences) => invoke<Preferences>("save_preferences", { preferences }),
  createVault: (path: string, masterPassword: string) =>
    invoke<VaultStatus>("create_vault", { path, masterPassword }),
  unlockVault: (path: string, masterPassword: string) =>
    invoke<VaultStatus>("unlock_vault", { path, masterPassword }),
  lockVault: () => invoke<void>("lock_vault"),
  listEntries: () => invoke<VaultEntry[]>("list_entries"),
  upsertEntry: (entry: VaultEntry) => invoke<VaultEntry[]>("upsert_entry", { entry }),
  deleteEntry: (id: string) => invoke<VaultEntry[]>("delete_entry", { id }),
  changeMasterPassword: (oldPassword: string, newPassword: string) =>
    invoke<VaultStatus>("change_master_password", { oldPassword, newPassword }),
  generatePassword: (options: GeneratePasswordOptions) =>
    invoke<string>("generate_password", { options }),
  importLegacyPreview: (path: string, legacyPassword?: string) =>
    invoke<ImportPreview>("import_legacy_preview", {
      path,
      legacyPassword: legacyPassword || null,
    }),
  importLegacyCommit: (importId: string) =>
    invoke<VaultEntry[]>("import_legacy_commit", { importId }),
  saveVault: () => invoke<VaultStatus>("save_vault"),
  exportVaultCopy: (path: string) => invoke<VaultStatus>("export_vault_copy", { path }),
  exportLegacyXml: (path: string) => invoke<number>("export_legacy_xml", { path }),
  getSyncConfig: () => invoke<SyncConfig | null>("get_sync_config"),
  setSyncConfig: (config: SyncConfig) => invoke<VaultStatus>("set_sync_config", { config }),
  testSync: (config: SyncConfig) => invoke<void>("test_sync", { config }),
  syncNow: () => invoke<SyncResult>("sync_now"),
};

export default Api;

