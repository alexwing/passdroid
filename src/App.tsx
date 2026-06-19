import {
  ArrowLeft,
  Briefcase,
  Building2,
  Clock,
  Cloud,
  Copy,
  CreditCard,
  Download,
  Eye,
  EyeOff,
  FileLock2,
  FileText,
  FolderOpen,
  Globe2,
  Heart,
  Import,
  KeyRound,
  Landmark,
  Lock,
  type LucideIcon,
  Mail,
  Moon,
  Palette,
  Plus,
  RefreshCw,
  Save,
  Search,
  Server,
  Settings,
  ShieldCheck,
  Sparkles,
  Star,
  Sun,
  Trash2,
  User,
  Wand2,
  Wifi,
  X,
} from "lucide-react";
import { FormEvent, ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { readFile, readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import appIcon from "./assets/passdroid.png";
import Api, {
  GeneratePasswordOptions,
  ImportPreview,
  Preferences,
  SyncConfig,
  VaultEntry,
  VaultStatus,
} from "./api";
import { createTranslator, resolveLanguage, ThemePreference, TranslationKey } from "./i18n";

type Screen = "start" | "unlock" | "vault";
type Notice = { kind: "success" | "error"; text: string } | null;

const defaultPreferences: Preferences = {
  theme: "system",
  language: "system",
  recentVaults: [],
  vaultIcons: {},
};

// Curated icon set a user can assign to a vault. The chosen key is stored in
// preferences (not in the vault) so it shows on the start screen while locked.
const VAULT_ICONS: Record<string, LucideIcon> = {
  safe: FileLock2,
  lock: Lock,
  key: KeyRound,
  mail: Mail,
  globe: Globe2,
  card: CreditCard,
  bank: Landmark,
  building: Building2,
  wifi: Wifi,
  server: Server,
  user: User,
  shield: ShieldCheck,
  cloud: Cloud,
  work: Briefcase,
  star: Star,
  heart: Heart,
};
const DEFAULT_VAULT_ICON = "safe";

const defaultSync: SyncConfig = {
  enabled: false,
  protocol: "ftp",
  host: "",
  port: 21,
  username: "",
  password: "",
  remoteDir: "vault",
  remoteFile: "passdroid.pdvault",
};

// Base file name from a real path OR an Android content:// URI (which encodes
// the path, e.g. .../document/primary%3ADocuments%2Fpassdroid.pdvault).
const vaultLabel = (path: string) => {
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    /* keep raw on malformed encoding */
  }
  return decoded.split(/[\\/:]/).filter(Boolean).pop() || path;
};

// File name without directory or extension, for the recents list and unlock screen.
const vaultName = (path: string) => vaultLabel(path).replace(/\.[^.]+$/, "");

const emptyEntry = (): VaultEntry => ({
  id: "",
  title: "",
  username: "",
  password: "",
  url: "",
  notes: "",
  createdAt: "",
  updatedAt: "",
  deletedAt: null,
  conflict: false,
});

function App() {
  const [preferences, setPreferences] = useState<Preferences>(defaultPreferences);
  const [screen, setScreen] = useState<Screen>("start");
  const [vaultPath, setVaultPath] = useState("");
  const [vaultStatus, setVaultStatus] = useState<VaultStatus | null>(null);
  const [createPassword, setCreatePassword] = useState("");
  const [createPasswordRepeat, setCreatePasswordRepeat] = useState("");
  const [unlockPassword, setUnlockPassword] = useState("");
  const [entries, setEntries] = useState<VaultEntry[]>([]);
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState<VaultEntry>(emptyEntry());
  const [selectedId, setSelectedId] = useState("");
  // On narrow screens the editor opens as a full-screen overlay instead of a
  // panel below the list (which would require scrolling to reach).
  const [editing, setEditing] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [generatorOpen, setGeneratorOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [iconPickerPath, setIconPickerPath] = useState<string | null>(null);
  const [changePasswordForm, setChangePasswordForm] = useState({
    oldPassword: "",
    newPassword: "",
    repeatPassword: "",
  });
  const [generatorOptions, setGeneratorOptions] = useState<GeneratePasswordOptions>({
    length: 18,
    uppercase: true,
    lowercase: true,
    numbers: true,
    symbols: true,
  });
  const [generatedPassword, setGeneratedPassword] = useState("");
  const [legacyPath, setLegacyPath] = useState("");
  const [legacyPassword, setLegacyPassword] = useState("");
  const [importPreview, setImportPreview] = useState<ImportPreview | null>(null);
  const [syncConfig, setSyncConfig] = useState<SyncConfig | null>(null);
  const [syncForm, setSyncForm] = useState<SyncConfig>(defaultSync);
  const [syncState, setSyncState] = useState<"idle" | "syncing" | "ok" | "error">("idle");
  // Suppress the auto-lock-on-background while a native file picker is in front
  // (the picker backgrounds the webview, which would otherwise trigger a lock).
  const suppressLock = useRef(false);

  const t = useMemo(() => createTranslator(preferences.language), [preferences.language]);

  useEffect(() => {
    Api.getPreferences()
      .then(setPreferences)
      .catch(() => setPreferences(defaultPreferences));
  }, []);

  useEffect(() => {
    const applyTheme = () => {
      const resolvedTheme =
        preferences.theme === "system"
          ? window.matchMedia("(prefers-color-scheme: dark)").matches
            ? "dark"
            : "light"
          : preferences.theme;
      document.documentElement.dataset.theme = resolvedTheme;
      document.documentElement.lang = resolveLanguage(preferences.language);
    };

    applyTheme();
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", applyTheme);
    return () => media.removeEventListener("change", applyTheme);
  }, [preferences]);

  // Security: lock the open vault when the app goes to the background (app
  // switch, recents, screen off) so returning requires the master password
  // again — like the original Passdroid. The vault path is kept so the unlock
  // screen targets the same vault.
  useEffect(() => {
    const handleHidden = () => {
      if (!document.hidden || screen !== "vault" || suppressLock.current) return;
      Api.lockVault().catch(() => {});
      setEntries([]);
      setDraft(emptyEntry());
      setSelectedId("");
      setEditing(false);
      setSyncState("idle");
      setUnlockPassword("");
      setScreen("unlock");
    };
    document.addEventListener("visibilitychange", handleHidden);
    return () => document.removeEventListener("visibilitychange", handleHidden);
  }, [screen]);

  const filteredEntries = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return entries;
    return entries.filter((entry) =>
      [entry.title, entry.username, entry.url, entry.notes].some((value) =>
        value.toLowerCase().includes(term),
      ),
    );
  }, [entries, query]);

  // Load the selected entry into the editor only when the selection changes.
  // Re-fetching the list returns fresh object identities for the same entries,
  // so depending on the entry object would clobber unsaved edits on every save.
  useEffect(() => {
    const selected = entries.find((entry) => entry.id === selectedId);
    setDraft(selected ?? emptyEntry());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  const run = async <T,>(operation: () => Promise<T>, successKey?: TranslationKey) => {
    setBusy(true);
    setNotice(null);
    try {
      const result = await operation();
      if (successKey) setNotice({ kind: "success", text: t(successKey) });
      return result;
    } catch (error) {
      setNotice({ kind: "error", text: formatError(error, t) });
      return null;
    } finally {
      setBusy(false);
    }
  };

  const persistPreferences = (next: Preferences) => {
    setPreferences(next);
    Api.savePreferences(next).catch(() => {});
  };

  const rememberVault = (path: string) => {
    persistPreferences({
      ...preferences,
      recentVaults: [path, ...preferences.recentVaults.filter((item) => item !== path)].slice(0, 8),
    });
  };

  const removeRecent = (path: string) => {
    persistPreferences({
      ...preferences,
      recentVaults: preferences.recentVaults.filter((item) => item !== path),
    });
  };

  const getVaultIcon = (path: string) => preferences.vaultIcons[path] ?? DEFAULT_VAULT_ICON;

  const setVaultIcon = (path: string, icon: string) => {
    persistPreferences({
      ...preferences,
      vaultIcons: { ...preferences.vaultIcons, [path]: icon },
    });
    setIconPickerPath(null);
  };

  const openRecent = (path: string) => {
    setVaultPath(path);
    setUnlockPassword("");
    setNotice(null);
    setScreen("unlock");
  };

  // Silent background sync (on unlock / after saves): pull + merge + push and
  // refresh the list. Failures (offline) are swallowed but reflected in syncState.
  const autoSync = async () => {
    setSyncState("syncing");
    try {
      const result = await Api.syncNow();
      await writeTextFile(vaultPath, result.contents);
      const list = await Api.listEntries();
      setEntries(list);
      setSyncState("ok");
    } catch {
      setSyncState("error");
    }
  };

  const maybeAutoSync = () => {
    if (syncConfig?.enabled) void autoSync();
  };

  // Manual sync (top bar / settings): same work, but surfaces success/error.
  const manualSync = async () => {
    setSyncState("syncing");
    const result = await run(async () => {
      const r = await Api.syncNow();
      await writeTextFile(vaultPath, r.contents);
      return Api.listEntries();
    }, "syncDone");
    if (result) {
      setEntries(result);
      setSyncState("ok");
    } else {
      setSyncState("error");
    }
  };

  const saveSyncConfig = async () => {
    const snapshot = await run(async () => {
      const snap = await Api.setSyncConfig(syncForm);
      await writeTextFile(vaultPath, snap.contents);
      return snap;
    }, "syncSaved");
    if (snapshot) {
      setSyncConfig(syncForm);
      setVaultStatus(snapshot.status);
      // Push immediately so the remote file appears right after configuring.
      if (syncForm.enabled) await manualSync();
    }
  };

  const testSyncConnection = () => run(() => Api.testSync(syncForm), "syncOk");

  // Run a native file dialog with auto-lock suppressed (the picker backgrounds
  // the webview, which must not trigger the lock-on-background).
  const pick = async <T,>(fn: () => Promise<T>): Promise<T> => {
    suppressLock.current = true;
    try {
      return await fn();
    } finally {
      suppressLock.current = false;
    }
  };

  const chooseVaultForCreate = async () => {
    const selected = await pick(() =>
      save({
        defaultPath: "passdroid.pdvault",
        filters: [{ name: t("vaultFile"), extensions: ["pdvault"] }],
      }),
    );
    if (selected) setVaultPath(selected);
  };

  const chooseVaultForOpen = async () => {
    const selected = await pick(() =>
      open({
        multiple: false,
        filters: [{ name: t("vaultFile"), extensions: ["pdvault"] }],
      }),
    );
    if (typeof selected === "string") {
      setVaultPath(selected);
      setUnlockPassword("");
      setScreen("unlock");
    }
  };

  const createVault = async (event: FormEvent) => {
    event.preventDefault();
    if (!vaultPath) {
      setNotice({ kind: "error", text: t("requiredVaultPath") });
      return;
    }
    if (createPassword !== createPasswordRepeat) {
      setNotice({ kind: "error", text: t("passwordMismatch") });
      return;
    }

    const snapshot = await run(async () => {
      const snap = await Api.createVault(createPassword);
      await writeTextFile(vaultPath, snap.contents);
      return snap;
    }, "vaultCreated");
    if (snapshot) {
      setVaultStatus(snapshot.status);
      rememberVault(vaultPath);
      setEntries([]);
      setDraft(emptyEntry());
      setSelectedId("");
      setCreatePassword("");
      setCreatePasswordRepeat("");
      setSyncConfig(null);
      setSyncForm(defaultSync);
      setSyncState("idle");
      setEditing(false);
      setScreen("vault");
    }
  };

  const unlockVault = async (event: FormEvent) => {
    event.preventDefault();
    const status = await run(async () => {
      let contents: string;
      try {
        contents = await readTextFile(vaultPath);
      } catch {
        // Distinguish "can't read the file" (e.g. a lapsed Android content-URI
        // permission) from a genuinely wrong master password.
        throw "vault_file_unreadable";
      }
      return Api.unlockVault(contents, unlockPassword);
    }, "vaultUnlocked");
    if (status) {
      setVaultStatus(status);
      rememberVault(vaultPath);
      const loaded = await run(() => Api.listEntries());
      setEntries(loaded ?? []);
      setUnlockPassword("");
      setDraft(emptyEntry());
      setSelectedId("");
      setEditing(false);
      setScreen("vault");
      const cfg = await Api.getSyncConfig().catch(() => null);
      setSyncConfig(cfg);
      setSyncForm(cfg ?? defaultSync);
      if (cfg?.enabled) void autoSync();
    }
  };

  const lockVault = async () => {
    // lock_vault returns Result<(), _>; Tauri marshals Ok(()) to JS `null`, so we
    // cannot gate the UI reset on the resolved value. Always clear the unlocked
    // state and return to the start screen — locking must never leave secrets on screen.
    await run(() => Api.lockVault(), "vaultLocked");
    setEntries([]);
    setDraft(emptyEntry());
    setSelectedId("");
    setQuery("");
    setVaultStatus(null);
    setVaultPath("");
    setSyncConfig(null);
    setSyncForm(defaultSync);
    setSyncState("idle");
    setEditing(false);
    setScreen("start");
  };

  const saveEntry = async (event: FormEvent) => {
    event.preventDefault();
    if (!draft.title.trim()) {
      setNotice({ kind: "error", text: t("requiredTitle") });
      return;
    }
    const existingId = draft.id;
    const knownIds = new Set(entries.map((entry) => entry.id));
    const snapshot = await run(async () => {
      const snap = await Api.upsertEntry(draft);
      await writeTextFile(vaultPath, snap.contents);
      return snap;
    }, "saved");
    if (snapshot) {
      setEntries(snapshot.entries);
      // Updates keep their id; a create is the entry whose id is new in the
      // returned list (the backend assigns the UUID and trims the title).
      const created = snapshot.entries.find((entry) => !knownIds.has(entry.id));
      const nextId = existingId || created?.id || "";
      if (nextId) setSelectedId(nextId);
      maybeAutoSync();
    }
  };

  const deleteCurrentEntry = async () => {
    if (!draft.id) return;
    const snapshot = await run(async () => {
      const snap = await Api.deleteEntry(draft.id);
      await writeTextFile(vaultPath, snap.contents);
      return snap;
    }, "entryDeleted");
    if (snapshot) {
      setEntries(snapshot.entries);
      setSelectedId("");
      setDraft(emptyEntry());
      setEditing(false);
      maybeAutoSync();
    }
  };

  const copyPassword = async () => {
    if (!draft.password) return;
    await navigator.clipboard.writeText(draft.password);
    setNotice({ kind: "success", text: t("copied") });
  };

  const exportCopy = async () => {
    const selected = await pick(() =>
      save({
        defaultPath: "passdroid-copy.pdvault",
        filters: [{ name: t("vaultFile"), extensions: ["pdvault"] }],
      }),
    );
    if (selected) {
      const ok = await run(async () => {
        const contents = await Api.exportVaultCopy();
        await writeTextFile(selected, contents);
        return true;
      }, "copyExported");
      if (ok) setExportOpen(false);
    }
  };

  const exportLegacyXml = async () => {
    const selected = await pick(() =>
      save({
        defaultPath: "passdroid-export.xml",
        filters: [{ name: "XML", extensions: ["xml"] }],
      }),
    );
    if (selected) {
      const ok = await run(async () => {
        const xml = await Api.exportLegacyXml();
        await writeTextFile(selected, xml);
        return true;
      }, "xmlExported");
      if (ok) setExportOpen(false);
    }
  };

  const updatePreferences = async (next: Preferences) => {
    setPreferences(next);
    await run(() => Api.savePreferences(next));
  };

  const changeMasterPassword = async (event: FormEvent) => {
    event.preventDefault();
    if (changePasswordForm.newPassword !== changePasswordForm.repeatPassword) {
      setNotice({ kind: "error", text: t("passwordMismatch") });
      return;
    }
    const snapshot = await run(async () => {
      const snap = await Api.changeMasterPassword(
        changePasswordForm.oldPassword,
        changePasswordForm.newPassword,
      );
      await writeTextFile(vaultPath, snap.contents);
      return snap;
    }, "passwordChanged");
    if (snapshot) {
      setVaultStatus(snapshot.status);
      setChangePasswordForm({ oldPassword: "", newPassword: "", repeatPassword: "" });
    }
  };

  const generatePassword = async () => {
    const password = await run(() => Api.generatePassword(generatorOptions));
    if (password) setGeneratedPassword(password);
  };

  const useGeneratedPassword = () => {
    if (!generatedPassword) return;
    setDraft((entry) => ({ ...entry, password: generatedPassword }));
    setGeneratorOpen(false);
  };

  const chooseLegacyFile = async () => {
    const selected = await pick(() =>
      open({
        multiple: false,
        filters: [{ name: "Passdroid", extensions: ["xml", "db"] }],
      }),
    );
    if (typeof selected === "string") {
      setLegacyPath(selected);
      setImportPreview(null);
    }
  };

  const previewImport = async (event: FormEvent) => {
    event.preventDefault();
    if (!legacyPath) {
      setNotice({ kind: "error", text: t("requiredLegacyPath") });
      return;
    }
    const preview = await run(async () => {
      const bytes = await readFile(legacyPath);
      return Api.importLegacyPreview(vaultLabel(legacyPath), Array.from(bytes), legacyPassword);
    }, "importReady");
    if (preview) setImportPreview(preview);
  };

  const commitImport = async () => {
    if (!importPreview) {
      setNotice({ kind: "error", text: t("requiredImportPreview") });
      return;
    }
    const snapshot = await run(async () => {
      const snap = await Api.importLegacyCommit(importPreview.importId);
      await writeTextFile(vaultPath, snap.contents);
      return snap;
    }, "importDone");
    if (snapshot) {
      setEntries(snapshot.entries);
      closeImport();
      maybeAutoSync();
    }
  };

  const closeSettings = () => {
    setSettingsOpen(false);
    setChangePasswordForm({ oldPassword: "", newPassword: "", repeatPassword: "" });
  };

  const closeGenerator = () => {
    setGeneratorOpen(false);
    setGeneratedPassword("");
  };

  const closeImport = () => {
    setImportOpen(false);
    setLegacyPath("");
    setLegacyPassword("");
    setImportPreview(null);
  };

  return (
    <div className="app-shell">
      {screen === "start" && (
        <main className="start-layout">
          <section className="brand">
            <img className="brand-icon" src={appIcon} alt="" width={44} height={44} />
            <h1>{t("appName")}</h1>
          </section>

          <section className="start-actions">
            <div className="panel">
              <div className="panel-heading">
                <FolderOpen size={22} aria-hidden />
                <h2>{t("existingVault")}</h2>
              </div>
              <button className="secondary-button full" type="button" onClick={chooseVaultForOpen} disabled={busy}>
                <FolderOpen size={18} aria-hidden />
                {t("openVault")}
              </button>
              {preferences.recentVaults.length > 0 && (
                <div className="recent-vaults">
                  <h3>{t("recentVaults")}</h3>
                  <div className="recent-list">
                    {preferences.recentVaults.map((path) => (
                      <div className="recent-row" key={path}>
                        <button className="recent-open" type="button" onClick={() => openRecent(path)} title={vaultName(path)}>
                          <VaultGlyph icon={getVaultIcon(path)} size={18} />
                          <span className="recent-name">{vaultName(path)}</span>
                        </button>
                        <button
                          className="icon-button"
                          type="button"
                          onClick={() => setIconPickerPath(path)}
                          title={t("chooseIcon")}
                          aria-label={t("chooseIcon")}
                        >
                          <Palette size={16} aria-hidden />
                        </button>
                        <button
                          className="icon-button"
                          type="button"
                          onClick={() => removeRecent(path)}
                          title={t("removeFromList")}
                          aria-label={t("removeFromList")}
                        >
                          <X size={16} aria-hidden />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <form className="panel" onSubmit={createVault}>
              <div className="panel-heading">
                <KeyRound size={22} aria-hidden />
                <h2>{t("newVault")}</h2>
              </div>
              <FilePickerRow label={t("vaultFile")} path={vaultPath} onPick={chooseVaultForCreate} t={t} />
              <PasswordInput
                label={t("masterPassword")}
                value={createPassword}
                onChange={setCreatePassword}
              />
              <PasswordInput
                label={t("repeatPassword")}
                value={createPasswordRepeat}
                onChange={setCreatePasswordRepeat}
              />
              <button className="primary-button" type="submit" disabled={busy}>
                <Save size={18} aria-hidden />
                {t("createVault")}
              </button>
            </form>
          </section>
        </main>
      )}

      {screen === "unlock" && (
        <main className="unlock-layout">
          <form className="panel unlock-panel" onSubmit={unlockVault}>
            <div className="panel-heading">
              <Lock size={22} aria-hidden />
              <h2>{t("unlock")}</h2>
            </div>
            <div className="vault-chip">
              <VaultGlyph icon={getVaultIcon(vaultPath)} size={20} />
              <span>{vaultName(vaultPath)}</span>
            </div>
            <PasswordInput
              label={t("masterPassword")}
              value={unlockPassword}
              onChange={setUnlockPassword}
              autoFocus
            />
            <button className="primary-button" type="submit" disabled={busy}>
              <Lock size={18} aria-hidden />
              {t("unlock")}
            </button>
            <button className="ghost-button" type="button" onClick={() => setScreen("start")}>
              {t("cancel")}
            </button>
          </form>
        </main>
      )}

      {screen === "vault" && (
        <>
          <header className="topbar">
            <div className="topbar-title">
              <FileLock2 size={26} aria-hidden />
              <div>
                <strong>{t("appName")}</strong>
                <span>{vaultStatus?.entryCount ?? entries.length}</span>
              </div>
            </div>
            <div className="topbar-actions">
              {syncConfig?.enabled && (
                <button
                  className={`icon-button sync-button ${syncState}`}
                  type="button"
                  title={
                    syncState === "syncing"
                      ? t("syncing")
                      : syncState === "error"
                        ? t("syncFailed")
                        : syncState === "ok"
                          ? t("syncDone")
                          : t("syncNow")
                  }
                  aria-label={t("syncNow")}
                  onClick={manualSync}
                  disabled={busy || syncState === "syncing"}
                >
                  <RefreshCw size={19} className={syncState === "syncing" ? "spin" : ""} aria-hidden />
                </button>
              )}
              <button className="icon-button" type="button" title={t("generator")} aria-label={t("generator")} onClick={() => setGeneratorOpen(true)}>
                <Wand2 size={19} aria-hidden />
              </button>
              <button className="icon-button" type="button" title={t("importLegacy")} aria-label={t("importLegacy")} onClick={() => setImportOpen(true)}>
                <Import size={19} aria-hidden />
              </button>
              <button className="icon-button" type="button" title={t("exportData")} aria-label={t("exportData")} onClick={() => setExportOpen(true)}>
                <Download size={19} aria-hidden />
              </button>
              <button className="icon-button" type="button" title={t("settings")} aria-label={t("settings")} onClick={() => setSettingsOpen(true)}>
                <Settings size={19} aria-hidden />
              </button>
              <button className="icon-button" type="button" title={t("lock")} aria-label={t("lock")} onClick={lockVault}>
                <Lock size={19} aria-hidden />
              </button>
            </div>
          </header>

          <main className="vault-layout">
            <aside className="entry-sidebar">
              <div className="search-box">
                <Search size={18} aria-hidden />
                <input
                  aria-label={t("search")}
                  placeholder={t("search")}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </div>
              <button
                className="secondary-button full"
                type="button"
                onClick={() => {
                  setSelectedId("");
                  setDraft(emptyEntry());
                  setEditing(true);
                }}
              >
                <Plus size={18} aria-hidden />
                {t("newEntry")}
              </button>
              <div className="entry-list">
                {filteredEntries.map((entry) => (
                  <button
                    className={`entry-row ${entry.id === selectedId ? "active" : ""}`}
                    key={entry.id}
                    type="button"
                    onClick={() => {
                      setSelectedId(entry.id);
                      setEditing(true);
                    }}
                  >
                    <span>{entry.title}</span>
                    <small>{entry.username || entry.url}</small>
                    {entry.conflict && <em>{t("conflict")}</em>}
                  </button>
                ))}
                {entries.length === 0 && <p className="empty-state">{t("emptyVault")}</p>}
                {entries.length > 0 && filteredEntries.length === 0 && (
                  <p className="empty-state">{t("noSearchResults")}</p>
                )}
              </div>
            </aside>

            <section className={`editor-panel ${editing ? "editing" : ""}`}>
              <button className="ghost-button editor-back" type="button" onClick={() => setEditing(false)}>
                <ArrowLeft size={18} aria-hidden />
                {t("back")}
              </button>
              <form className="entry-form" onSubmit={saveEntry}>
                <label>
                  <span>{t("title")}</span>
                  <input
                    value={draft.title}
                    onChange={(event) => setDraft({ ...draft, title: event.target.value })}
                    autoComplete="off"
                  />
                </label>
                <label>
                  <span>{t("username")}</span>
                  <input
                    value={draft.username}
                    onChange={(event) => setDraft({ ...draft, username: event.target.value })}
                    autoComplete="username"
                  />
                </label>
                <label>
                  <span>{t("password")}</span>
                  <div className="password-row">
                    <input
                      type={showPassword ? "text" : "password"}
                      value={draft.password}
                      onChange={(event) => setDraft({ ...draft, password: event.target.value })}
                      autoComplete="new-password"
                    />
                    <button className="icon-button" type="button" title={t("password")} aria-label={t("password")} onClick={() => setShowPassword((value) => !value)}>
                      {showPassword ? <EyeOff size={18} aria-hidden /> : <Eye size={18} aria-hidden />}
                    </button>
                    <button className="icon-button" type="button" title={t("copy")} aria-label={t("copy")} onClick={copyPassword}>
                      <Copy size={18} aria-hidden />
                    </button>
                  </div>
                </label>
                <label>
                  <span>{t("url")}</span>
                  <input
                    value={draft.url}
                    onChange={(event) => setDraft({ ...draft, url: event.target.value })}
                    autoComplete="url"
                  />
                </label>
                <label className="notes-field">
                  <span>{t("notes")}</span>
                  <textarea
                    value={draft.notes}
                    onChange={(event) => setDraft({ ...draft, notes: event.target.value })}
                  />
                </label>
                <div className="form-actions">
                  <button className="primary-button" type="submit" disabled={busy}>
                    <Save size={18} aria-hidden />
                    {t("save")}
                  </button>
                  <button className="danger-button" type="button" onClick={deleteCurrentEntry} disabled={!draft.id || busy}>
                    <Trash2 size={18} aria-hidden />
                    {t("delete")}
                  </button>
                </div>
              </form>
            </section>
          </main>
        </>
      )}

      {notice && (
        <div className={`notice ${notice.kind}`} role={notice.kind === "error" ? "alert" : "status"}>
          <span>{notice.kind === "error" ? t("error") : notice.text}</span>
          {notice.kind === "error" && <p>{notice.text}</p>}
        </div>
      )}

      {settingsOpen && (
        <Modal title={t("settings")} onClose={closeSettings} t={t}>
          <div className="settings-grid">
            <section>
              <h3>{t("theme")}</h3>
              <Segmented
                value={preferences.theme}
                options={[
                  { value: "system", label: t("system"), icon: <Settings size={16} aria-hidden /> },
                  { value: "light", label: t("light"), icon: <Sun size={16} aria-hidden /> },
                  { value: "dark", label: t("dark"), icon: <Moon size={16} aria-hidden /> },
                ]}
                onChange={(theme) => updatePreferences({ ...preferences, theme: theme as ThemePreference })}
              />
            </section>
            <section>
              <h3>{t("language")}</h3>
              <Segmented
                value={preferences.language}
                options={[
                  { value: "system", label: t("system"), icon: <Globe2 size={16} aria-hidden /> },
                  { value: "es", label: t("spanish"), icon: <Globe2 size={16} aria-hidden /> },
                  { value: "en", label: t("english"), icon: <Globe2 size={16} aria-hidden /> },
                ]}
                onChange={(language) => updatePreferences({ ...preferences, language: language as Preferences["language"] })}
              />
            </section>
          </div>
          <form className="stack-form" onSubmit={changeMasterPassword}>
            <h3>{t("changePassword")}</h3>
            <PasswordInput
              label={t("oldPassword")}
              value={changePasswordForm.oldPassword}
              onChange={(value) => setChangePasswordForm({ ...changePasswordForm, oldPassword: value })}
            />
            <PasswordInput
              label={t("newPassword")}
              value={changePasswordForm.newPassword}
              onChange={(value) => setChangePasswordForm({ ...changePasswordForm, newPassword: value })}
            />
            <PasswordInput
              label={t("repeatNewPassword")}
              value={changePasswordForm.repeatPassword}
              onChange={(value) => setChangePasswordForm({ ...changePasswordForm, repeatPassword: value })}
            />
            <button className="primary-button" type="submit" disabled={busy}>
              <KeyRound size={18} aria-hidden />
              {t("apply")}
            </button>
          </form>

          <section className="stack-form">
            <h3>{t("sync")}</h3>
            <p className="sync-warning">{t("syncPlainWarning")}</p>
            <Toggle
              label={t("syncEnabled")}
              checked={syncForm.enabled}
              onChange={(enabled) => setSyncForm({ ...syncForm, enabled })}
            />
            <div className="settings-grid">
              <label>
                <span>{t("syncHost")}</span>
                <input
                  value={syncForm.host}
                  onChange={(event) => setSyncForm({ ...syncForm, host: event.target.value })}
                  autoComplete="off"
                />
              </label>
              <label>
                <span>{t("syncPort")}</span>
                <input
                  type="number"
                  min={1}
                  max={65535}
                  value={syncForm.port}
                  onChange={(event) => setSyncForm({ ...syncForm, port: Number(event.target.value) })}
                />
              </label>
              <label>
                <span>{t("syncUser")}</span>
                <input
                  value={syncForm.username}
                  onChange={(event) => setSyncForm({ ...syncForm, username: event.target.value })}
                  autoComplete="off"
                />
              </label>
              <label>
                <span>{t("syncPassword")}</span>
                <input
                  type="password"
                  value={syncForm.password}
                  onChange={(event) => setSyncForm({ ...syncForm, password: event.target.value })}
                  autoComplete="new-password"
                />
              </label>
              <label>
                <span>{t("syncDir")}</span>
                <input
                  value={syncForm.remoteDir}
                  onChange={(event) => setSyncForm({ ...syncForm, remoteDir: event.target.value })}
                  autoComplete="off"
                />
              </label>
              <label>
                <span>{t("syncFile")}</span>
                <input
                  value={syncForm.remoteFile}
                  onChange={(event) => setSyncForm({ ...syncForm, remoteFile: event.target.value })}
                  autoComplete="off"
                />
              </label>
            </div>
            <div className="sync-actions">
              <button className="secondary-button" type="button" onClick={testSyncConnection} disabled={busy}>
                <Globe2 size={18} aria-hidden />
                {t("syncTest")}
              </button>
              <button className="primary-button" type="button" onClick={saveSyncConfig} disabled={busy}>
                <Save size={18} aria-hidden />
                {t("syncSaveConfig")}
              </button>
              <button
                className="secondary-button"
                type="button"
                onClick={manualSync}
                disabled={busy || syncState === "syncing" || !syncConfig?.enabled}
              >
                <RefreshCw size={18} aria-hidden />
                {t("syncNow")}
              </button>
            </div>
          </section>
        </Modal>
      )}

      {generatorOpen && (
        <Modal title={t("generator")} onClose={closeGenerator} t={t}>
          <div className="generator-layout">
            <label>
              <span>{t("length")}</span>
              <input
                type="number"
                min={8}
                max={256}
                value={generatorOptions.length}
                onChange={(event) =>
                  setGeneratorOptions({ ...generatorOptions, length: Number(event.target.value) })
                }
              />
            </label>
            <Toggle label={t("uppercase")} checked={generatorOptions.uppercase} onChange={(uppercase) => setGeneratorOptions({ ...generatorOptions, uppercase })} />
            <Toggle label={t("lowercase")} checked={generatorOptions.lowercase} onChange={(lowercase) => setGeneratorOptions({ ...generatorOptions, lowercase })} />
            <Toggle label={t("numbers")} checked={generatorOptions.numbers} onChange={(numbers) => setGeneratorOptions({ ...generatorOptions, numbers })} />
            <Toggle label={t("symbols")} checked={generatorOptions.symbols} onChange={(symbols) => setGeneratorOptions({ ...generatorOptions, symbols })} />
            <button className="primary-button" type="button" onClick={generatePassword} disabled={busy}>
              <Sparkles size={18} aria-hidden />
              {t("generate")}
            </button>
            {generatedPassword && (
              <div className="generated-password">
                <code>{generatedPassword}</code>
                <button className="secondary-button" type="button" onClick={useGeneratedPassword}>
                  {t("usePassword")}
                </button>
              </div>
            )}
          </div>
        </Modal>
      )}

      {importOpen && (
        <Modal title={t("importLegacy")} onClose={closeImport} t={t}>
          <form className="stack-form" onSubmit={previewImport}>
            <FilePickerRow label={t("chooseFile")} path={legacyPath} onPick={chooseLegacyFile} t={t} />
            <PasswordInput
              label={t("legacyPassword")}
              value={legacyPassword}
              onChange={setLegacyPassword}
            />
            <button className="primary-button" type="submit" disabled={busy}>
              <Import size={18} aria-hidden />
              {t("previewImport")}
            </button>
          </form>
          {importPreview && (
            <section className="import-preview">
              <h3>
                {t("importedEntries")}: {importPreview.count}
              </h3>
              {importPreview.count > importPreview.entries.length && (
                <p className="empty-state">
                  {t("showingFirst")} {importPreview.entries.length}.
                </p>
              )}
              <div className="preview-list">
                {importPreview.entries.map((entry, index) => (
                  <div key={`${entry.title}-${index}`}>
                    <strong>{entry.title}</strong>
                    <span>{entry.username || entry.url}</span>
                  </div>
                ))}
              </div>
              <button className="primary-button" type="button" onClick={commitImport} disabled={busy}>
                <Save size={18} aria-hidden />
                {t("commitImport")}
              </button>
            </section>
          )}
        </Modal>
      )}

      {exportOpen && (
        <Modal title={t("exportData")} onClose={() => setExportOpen(false)} t={t}>
          <div className="export-options">
            <button className="export-option" type="button" onClick={exportCopy} disabled={busy}>
              <FileLock2 size={22} aria-hidden />
              <div>
                <strong>{t("exportEncrypted")}</strong>
                <span>{t("exportEncryptedHint")}</span>
              </div>
            </button>
            <button className="export-option danger" type="button" onClick={exportLegacyXml} disabled={busy}>
              <FileText size={22} aria-hidden />
              <div>
                <strong>{t("exportXmlPlain")}</strong>
                <span>{t("exportXmlWarning")}</span>
              </div>
            </button>
          </div>
        </Modal>
      )}

      {iconPickerPath !== null && (
        <Modal title={t("chooseIcon")} onClose={() => setIconPickerPath(null)} t={t}>
          <div className="icon-grid">
            {Object.keys(VAULT_ICONS).map((key) => (
              <button
                key={key}
                type="button"
                className={`icon-choice ${getVaultIcon(iconPickerPath) === key ? "active" : ""}`}
                onClick={() => setVaultIcon(iconPickerPath, key)}
                aria-label={key}
              >
                <VaultGlyph icon={key} size={22} />
              </button>
            ))}
          </div>
        </Modal>
      )}
    </div>
  );
}

function VaultGlyph({ icon, size }: { icon: string; size: number }) {
  const Icon = VAULT_ICONS[icon] ?? FileLock2;
  return <Icon size={size} aria-hidden />;
}

function PasswordInput({
  label,
  value,
  onChange,
  autoFocus,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoFocus?: boolean;
}) {
  return (
    <label>
      <span>{label}</span>
      <input
        type="password"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        autoFocus={autoFocus}
        autoComplete="current-password"
      />
    </label>
  );
}

function FilePickerRow({
  label,
  path,
  onPick,
  t,
}: {
  label: string;
  path: string;
  onPick: () => void;
  t: ReturnType<typeof createTranslator>;
}) {
  return (
    <label>
      <span>{label}</span>
      <div className="file-row">
        <input value={path} readOnly />
        <button className="icon-button" type="button" onClick={onPick} title={t("chooseVault")} aria-label={t("chooseVault")}>
          <FolderOpen size={18} aria-hidden />
        </button>
      </div>
    </label>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="toggle-row">
      <span>{label}</span>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
    </label>
  );
}

function Segmented({
  value,
  options,
  onChange,
}: {
  value: string;
  options: { value: string; label: string; icon: ReactNode }[];
  onChange: (value: string) => void;
}) {
  return (
    <div className="segmented">
      {options.map((option) => (
        <button
          key={option.value}
          className={value === option.value ? "active" : ""}
          type="button"
          onClick={() => onChange(option.value)}
        >
          {option.icon}
          {option.label}
        </button>
      ))}
    </div>
  );
}

function Modal({
  title,
  children,
  onClose,
  t,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  t: ReturnType<typeof createTranslator>;
}) {
  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <section
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
      >
        <header>
          <h2>{title}</h2>
          <button className="icon-button" type="button" onClick={onClose} aria-label={t("close")} title={t("close")}>
            <X size={18} aria-hidden />
          </button>
        </header>
        {children}
        <footer className="modal-footer">
          <button className="ghost-button" type="button" onClick={onClose}>
            {t("close")}
          </button>
        </footer>
      </section>
    </div>
  );
}

function formatError(error: unknown, t: ReturnType<typeof createTranslator>) {
  const raw = typeof error === "string" ? error : error instanceof Error ? error.message : "unknown";
  const key = `err_${raw}` as TranslationKey;
  const translated = t(key);
  return translated === key ? t("err_unknown") : translated;
}

export default App;
