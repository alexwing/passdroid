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
  vaultId: string;
  revision: number;
  entryCount: number;
  icon: string;
}

export interface VaultSnapshot {
  status: VaultStatus;
  contents: string;
}

export interface EntriesSnapshot {
  entries: VaultEntry[];
  contents: string;
}

export interface Preferences {
  theme: ThemePreference;
  language: LanguagePreference;
  recentVaults: string[];
  vaultIcons: Record<string, string>;
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
  contents: string;
}

const Api = {
  getPreferences: () => invoke<Preferences>("get_preferences"),
  savePreferences: (preferences: Preferences) => invoke<Preferences>("save_preferences", { preferences }),
  createVault: (masterPassword: string) =>
    invoke<VaultSnapshot>("create_vault", { masterPassword }),
  unlockVault: (contents: string, masterPassword: string) =>
    invoke<VaultStatus>("unlock_vault", { contents, masterPassword }),
  lockVault: () => invoke<void>("lock_vault"),
  listEntries: () => invoke<VaultEntry[]>("list_entries"),
  upsertEntry: (entry: VaultEntry) => invoke<EntriesSnapshot>("upsert_entry", { entry }),
  deleteEntry: (id: string) => invoke<EntriesSnapshot>("delete_entry", { id }),
  changeMasterPassword: (oldPassword: string, newPassword: string) =>
    invoke<VaultSnapshot>("change_master_password", { oldPassword, newPassword }),
  generatePassword: (options: GeneratePasswordOptions) =>
    invoke<string>("generate_password", { options }),
  importLegacyPreview: (name: string, contents: number[], legacyPassword?: string) =>
    invoke<ImportPreview>("import_legacy_preview", {
      name,
      contents,
      legacyPassword: legacyPassword || null,
    }),
  importLegacyCommit: (importId: string) =>
    invoke<EntriesSnapshot>("import_legacy_commit", { importId }),
  saveVault: () => invoke<VaultSnapshot>("save_vault"),
  exportVaultCopy: () => invoke<string>("export_vault_copy"),
  exportLegacyXml: () => invoke<string>("export_legacy_xml"),
  setVaultIcon: (icon: string) => invoke<VaultSnapshot>("set_vault_icon", { icon }),
  getSyncConfig: () => invoke<SyncConfig | null>("get_sync_config"),
  setSyncConfig: (config: SyncConfig) => invoke<VaultSnapshot>("set_sync_config", { config }),
  testSync: (config: SyncConfig) => invoke<void>("test_sync", { config }),
  syncNow: () => invoke<SyncResult>("sync_now"),
};

export default Api;

