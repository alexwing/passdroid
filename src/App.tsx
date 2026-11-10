import {
  AlertTriangle,
  Briefcase,
  Building2,
  ChevronLeft,
  ChevronRight,
  Cloud,
  Copy,
  CreditCard,
  Download,
  Edit3,
  ExternalLink,
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
  List,
  Lock,
  LockOpen,
  type LucideIcon,
  Mail,
  Monitor,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  QrCode,
  RefreshCw,
  Save,
  Search,
  Server,
  Settings,
  ShieldCheck,
  Sliders,
  Sparkles,
  Star,
  Sun,
  Trash2,
  Upload,
  User,
  Wifi,
} from "lucide-react";
import { CSSProperties, FormEvent, ReactNode, Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { mkdir, readFile, readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { openUrl } from "@tauri-apps/plugin-opener";
import { appLocalDataDir, join } from "@tauri-apps/api/path";
import appIcon from "./assets/passdroid.png";
import Api, {
  ExportKind,
  GeneratePasswordOptions,
  ImportPreview,
  NotesView,
  Preferences,
  SyncCheck,
  SyncConfig,
  VaultEntry,
  VaultStatus,
} from "./api";
import type { ThemePreference } from "./i18n";
import { useTranslation } from "./context/LanguageContext";
import { useTheme } from "./context/ThemeContext";
import { QrCameraScanner } from "./components/QrCameraScanner";
import { QrVaultModal, parseQrPayload } from "./components/QrVaultModal";
import { Modal } from "./components/Modal";
import { Toast } from "./components/Toast";
import { TitleBar } from "./components/TitleBar";
import { NotesBoundary } from "./components/NotesPlain";
import { passwordStrength, type StrengthLevel } from "./utils/passwordStrength";

// Markdown pulls in react-markdown + remark-gfm (~170 kB), so it loads on first preview.
const NotesMarkdown = lazy(() => import("./components/NotesMarkdown").then((m) => ({ default: m.NotesMarkdown })));

type Screen = "start" | "unlock" | "vault";
type SettingsTab = "general" | "sync" | "security";
type Notice = { kind: "success" | "error"; text: string } | null;

const defaultPreferences: Preferences = {
  theme: "system",
  language: "system",
  recentVaults: [],
  vaultIcons: {},
  railCollapsed: false,
  notesView: "edit",
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
  protocol: "ftps",
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

// Parent folder + file, abbreviated (e.g. "…\Vaults\personal.pdvault"), for the
// recents list and the unlock screen. Works for real paths and content:// URIs.
const shortPath = (path: string) => {
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    /* keep raw on malformed encoding */
  }
  const sep = decoded.includes("\\") ? "\\" : "/";
  const parts = decoded.split(/[\\/:]/).filter(Boolean);
  return parts.length > 2 ? `…${sep}${parts.slice(-2).join(sep)}` : parts.join(sep);
};

// Stable hue (0-359) from a string, for the avatar tint of entries and vaults.
const hueOf = (seed: string) => {
  if (!seed) return 215;
  let hue = 0;
  for (const char of seed) hue = (hue * 31 + (char.codePointAt(0) ?? 0)) % 360;
  return hue;
};
const hueStyle = (seed: string) => ({ "--h": hueOf(seed) }) as CSSProperties;
const initialOf = (title: string) => (Array.from(title.trim())[0] ?? "?").toUpperCase();

const strengthTone = (level: StrengthLevel) => (level >= 3 ? "strong" : level === 2 ? "fair" : "weak");
const strengthKey = (level: StrengthLevel) =>
  level >= 3 ? "strengthStrong" : level === 2 ? "strengthFair" : "strengthWeak";

// Sync state per vault, remembered so the start screen can badge locked vaults.
// UI-only cache (never contains secrets); the real sync config lives in the vault.
type SyncBadge = "sync" | "local" | "pending";
const SYNC_BADGES_KEY = "passdroid.vaultSync";
const loadSyncBadges = (): Record<string, SyncBadge> => {
  try {
    const parsed = JSON.parse(localStorage.getItem(SYNC_BADGES_KEY) ?? "{}");
    const result: Record<string, SyncBadge> = {};
    for (const [path, badge] of Object.entries(parsed ?? {})) {
      if (badge === "sync" || badge === "local" || badge === "pending") result[path] = badge;
    }
    return result;
  } catch {
    return {};
  }
};

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
  const [createName, setCreateName] = useState("");
  const [isAndroid, setIsAndroid] = useState(false);
  const [unlockPassword, setUnlockPassword] = useState("");
  const [unlockError, setUnlockError] = useState("");
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
  const [vaultView, setVaultView] = useState<"entries" | "settings">("entries");
  const [deletePromptOpen, setDeletePromptOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("general");
  const [generatorOpen, setGeneratorOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [iconPickerOpen, setIconPickerOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [removePromptPath, setRemovePromptPath] = useState<string | null>(null);
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
  const [syncPrompt, setSyncPrompt] = useState<SyncCheck | null>(null);
  const [lastSyncAt, setLastSyncAt] = useState<Date | null>(null);
  const [vaultSyncBadges, setVaultSyncBadges] = useState<Record<string, SyncBadge>>(loadSyncBadges);
  // Suppress the auto-lock-on-background while a native file picker is in front
  // (the picker backgrounds the webview, which would otherwise trigger a lock).
  const suppressLock = useRef(false);
  const settingsTitleRef = useRef<HTMLHeadingElement>(null);

  // i18n and theme are now managed by their respective contexts (LanguageProvider / ThemeProvider).
  const { t, language, resolved, setLanguage } = useTranslation();
  const { mode: themeMode, setMode: setThemeMode } = useTheme();

  // QR vault linking state
  const [qrScannerOpen, setQrScannerOpen] = useState(false);
  const [qrShowModalOpen, setQrShowModalOpen] = useState(false);
  const [qrLinkConfig, setQrLinkConfig] = useState<SyncConfig | null>(null);
  const [qrLinkPassword, setQrLinkPassword] = useState("");

  useEffect(() => {
    Api.getPreferences()
      .then(setPreferences)
      .catch(() => setPreferences(defaultPreferences));
    Api.isAndroid()
      .then(setIsAndroid)
      .catch(() => {});
  }, []);

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
      setUnlockError("");
      setVaultView("entries");
      setChangePasswordForm({ oldPassword: "", newPassword: "", repeatPassword: "" });
      setScreen("unlock");
    };
    document.addEventListener("visibilitychange", handleHidden);
    return () => document.removeEventListener("visibilitychange", handleHidden);
  }, [screen]);

  // Toasts auto-dismiss after 5s (and can be closed manually).
  useEffect(() => {
    if (vaultView === "settings") settingsTitleRef.current?.focus({ preventScroll: true });
  }, [vaultView]);

  useEffect(() => {
    if (!notice) return;
    const id = window.setTimeout(() => setNotice(null), 5000);
    return () => window.clearTimeout(id);
  }, [notice]);

  const filteredEntries = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return entries;
    return entries.filter((entry) =>
      [entry.title, entry.username, entry.url, entry.notes].some((value) =>
        value.toLowerCase().includes(term),
      ),
    );
  }, [entries, query]);

  // Entries whose password is weak get a badge in the list.
  const weakIds = useMemo(
    () =>
      new Set(
        entries.filter((entry) => entry.password && passwordStrength(entry.password) <= 1).map((entry) => entry.id),
      ),
    [entries],
  );

  // Load the selected entry into the editor only when the selection changes.
  // Re-fetching the list returns fresh object identities for the same entries,
  // so depending on the entry object would clobber unsaved edits on every save.
  useEffect(() => {
    const selected = entries.find((entry) => entry.id === selectedId);
    setDraft(selected ?? emptyEntry());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  // `inlineError` routes a failure to a field instead of a toast.
  const run = async <T,>(
    operation: () => Promise<T>,
    successKey?: string,
    inlineError?: (message: string) => void,
  ) => {
    setBusy(true);
    setNotice(null);
    try {
      const result = await operation();
      if (successKey) setNotice({ kind: "success", text: t(successKey) });
      return result;
    } catch (error) {
      const message = formatError(error, t);
      if (inlineError) inlineError(message);
      else setNotice({ kind: "error", text: message });
      return null;
    } finally {
      setBusy(false);
    }
  };

  // Functional updater so sequential calls in the same tick compose instead of
  // clobbering each other (e.g. rememberVault + cacheVaultIcon on unlock).
  const persistPreferences = (update: (prev: Preferences) => Preferences) => {
    setPreferences((prev) => {
      const next = update(prev);
      if (next !== prev) void Api.savePreferences(next).catch(() => {});
      return next;
    });
  };

  // UI preferences (rail, notes view) are saved as a fresh read-modify-write, like theme
  // and language, so a stale copy in this component can never revert them on disk.
  const saveUiPreference = (patch: Partial<Pick<Preferences, "railCollapsed" | "notesView">>) => {
    setPreferences((prev) => ({ ...prev, ...patch }));
    Api.getPreferences()
      .then((fresh) => Api.savePreferences({ ...fresh, ...patch }))
      .catch(() => {});
  };

  const rememberVault = (path: string) => {
    persistPreferences((prev) => ({
      ...prev,
      recentVaults: [path, ...prev.recentVaults.filter((item) => item !== path)].slice(0, 8),
    }));
  };

  const removeRecent = (path: string) => {
    persistPreferences((prev) => ({
      ...prev,
      recentVaults: prev.recentVaults.filter((item) => item !== path),
    }));
    setSyncBadge(path, null);
  };

  const setSyncBadge = (path: string, badge: SyncBadge | null) => {
    if (!path) return;
    setVaultSyncBadges((prev) => {
      if ((prev[path] ?? null) === badge) return prev;
      const next = { ...prev };
      if (badge) next[path] = badge;
      else delete next[path];
      try {
        localStorage.setItem(SYNC_BADGES_KEY, JSON.stringify(next));
      } catch {
        /* storage unavailable: the badge just won't persist */
      }
      return next;
    });
  };

  // Locked-screen icon comes from the preferences cache (filled when the vault
  // was last opened); falls back to the default if the vault was never opened here.
  const getVaultIcon = (path: string) => preferences.vaultIcons[path] || DEFAULT_VAULT_ICON;

  const cacheVaultIcon = (path: string, icon: string) => {
    if (!icon) return;
    persistPreferences((prev) =>
      prev.vaultIcons[path] === icon
        ? prev
        : { ...prev, vaultIcons: { ...prev.vaultIcons, [path]: icon } },
    );
  };

  // Store the icon inside the vault (so it syncs across devices) and cache it
  // locally for the locked screen. Picked from Settings on the open vault.
  const applyVaultIcon = async (icon: string) => {
    const snapshot = await run(async () => {
      const snap = await Api.setVaultIcon(icon);
      await writeTextFile(vaultPath, snap.contents);
      return snap;
    });
    if (snapshot) {
      setVaultStatus(snapshot.status);
      cacheVaultIcon(vaultPath, icon);
    }
    setIconPickerOpen(false);
  };

  const openRecent = (path: string) => {
    setVaultPath(path);
    setUnlockPassword("");
    setUnlockError("");
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
      setLastSyncAt(new Date());
      setSyncBadge(vaultPath, "sync");
    } catch {
      setSyncState("error");
      setSyncBadge(vaultPath, "pending");
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
      setLastSyncAt(new Date());
      setSyncBadge(vaultPath, "sync");
    } else {
      setSyncState("error");
      setSyncBadge(vaultPath, "pending");
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
      setSyncBadge(vaultPath, syncForm.enabled ? "sync" : "local");
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

  // App-private vault path (Android): a real, always-accessible location, so we
  // never depend on a SAF content:// permission surviving a restart.
  const androidVaultPath = async (name: string) => {
    const base = await appLocalDataDir();
    const dir = await join(base, "vaults");
    await mkdir(dir, { recursive: true });
    return join(dir, `${name}.pdvault`);
  };

  const chooseVaultForOpen = async () => {
    const selected = await pick(() =>
      open({
        multiple: false,
        filters: [{ name: t("vaultFile"), extensions: ["pdvault"] }],
      }),
    );
    if (typeof selected !== "string") return;

    if (isAndroid) {
      // Copy the picked file into app-private storage once (the SAF permission
      // is valid right now), then use that copy from here on.
      const imported = await run(async () => {
        const contents = await readTextFile(selected);
        const path = await androidVaultPath(vaultName(selected) || "passdroid");
        await writeTextFile(path, contents);
        return path;
      }, "vaultImported");
      if (!imported) return;
      setVaultPath(imported);
    } else {
      setVaultPath(selected);
    }
    setUnlockPassword("");
    setScreen("unlock");
  };

  const createVault = async (event: FormEvent) => {
    event.preventDefault();
    if (createPassword !== createPasswordRepeat) {
      setNotice({ kind: "error", text: t("passwordMismatch") });
      return;
    }

    let path = vaultPath;
    if (isAndroid) {
      const name = createName.trim();
      if (!name) {
        setNotice({ kind: "error", text: t("requiredVaultName") });
        return;
      }
      try {
        path = await androidVaultPath(name);
      } catch {
        setNotice({ kind: "error", text: t("err_unknown") });
        return;
      }
    } else if (!path) {
      setNotice({ kind: "error", text: t("requiredVaultPath") });
      return;
    }

    const snapshot = await run(async () => {
      const snap = await Api.createVault(createPassword);
      await writeTextFile(path, snap.contents);
      return snap;
    }, "vaultCreated");
    if (snapshot) {
      setVaultPath(path);
      setVaultStatus(snapshot.status);
      rememberVault(path);
      setEntries([]);
      setDraft(emptyEntry());
      setSelectedId("");
      setCreatePassword("");
      setCreatePasswordRepeat("");
      setCreateName("");
      setSyncConfig(null);
      setSyncForm(defaultSync);
      setSyncState("idle");
      setSyncPrompt(null);
      setEditing(false);
      setSyncBadge(path, "local");
      setCreateOpen(false);
      setVaultView("entries");
      setScreen("vault");
    }
  };

  const closeCreate = () => {
    setCreateOpen(false);
    setCreatePassword("");
    setCreatePasswordRepeat("");
    setCreateName("");
    setVaultPath("");
  };

  const unlockVault = async (event: FormEvent) => {
    event.preventDefault();
    setUnlockError("");
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
    }, "vaultUnlocked", setUnlockError);
    if (status) {
      setVaultStatus(status);
      rememberVault(vaultPath);
      cacheVaultIcon(vaultPath, status.icon);
      const loaded = await run(() => Api.listEntries());
      setEntries(loaded ?? []);
      setUnlockPassword("");
      setDraft(emptyEntry());
      setSelectedId("");
      setEditing(false);
      setVaultView("entries");
      setScreen("vault");
      const cfg = await Api.getSyncConfig().catch(() => null);
      setSyncConfig(cfg);
      setSyncForm(cfg ?? defaultSync);
      setSyncBadge(vaultPath, cfg?.enabled ? "sync" : "local");
      // On open, check the remote and offer to download it if it is newer,
      // instead of silently pulling.
      if (cfg?.enabled) {
        Api.syncCheck()
          .then((check) => {
            if (check.remoteRevision != null && check.remoteRevision > check.localRevision) {
              setSyncPrompt(check);
            }
          })
          .catch(() => {});
      }
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
    setLastSyncAt(null);
    setSyncPrompt(null);
    setEditing(false);
    setVaultView("entries");
    setChangePasswordForm({ oldPassword: "", newPassword: "", repeatPassword: "" });
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

  const copyToClipboard = async (value: string) => {
    if (!value) return;
    await navigator.clipboard.writeText(value);
    setNotice({ kind: "success", text: t("copied") });
  };

  const isValidUrl = (value: string) => {
    try {
      const parsed = new URL(value.trim());
      return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
      return false;
    }
  };

  // Always hands the URL to the system opener; the webview itself never navigates.
  // Stable identity so the memoised Markdown preview is not re-parsed on every App render.
  const openExternal = useCallback(
    async (url: string) => {
      try {
        await openUrl(url);
      } catch {
        setNotice({ kind: "error", text: t("err_unknown") });
      }
    },
    [t],
  );

  const openDraftUrl = async () => {
    const url = draft.url.trim();
    if (!isValidUrl(url)) return;
    await openExternal(url);
  };

  // Write an export and prove it landed: read it back and verify it, so a
  // picker or write that silently produced an empty file is reported, never ignored.
  // Resolves to where it was saved, or null when the user cancelled the picker.
  const writeExport = async (
    kind: ExportKind,
    contents: string,
    defaultPath: string,
    filters: { name: string; extensions: string[] }[],
  ): Promise<string | null> => {
    if (isAndroid) {
      // Android skips the system picker (it can lose its result): the Kotlin plugin
      // saves into Download/Passdroid and verifies it. Only Android < 10 falls through.
      try {
        return (await Api.exportSaveAndroid(kind, contents)).path;
      } catch (error) {
        if (error !== "export_unsupported") throw error;
      }
    }

    let selected: string | null;
    try {
      selected = await pick(() => save({ defaultPath, filters }));
    } catch (error) {
      if (/cancel/i.test(String(error))) return null;
      throw "export_write_failed";
    }
    if (!selected) {
      // Desktop returns null on cancel; on Android a non-cancel without a file is a lost result.
      if (isAndroid) throw "export_no_file";
      return null;
    }

    try {
      await writeTextFile(selected, contents);
    } catch {
      throw "export_write_failed";
    }
    let written: string;
    try {
      written = await readTextFile(selected);
    } catch {
      throw "export_verify_failed";
    }
    if (written !== contents) throw "export_verify_failed";
    await Api.verifyExport(kind, written);
    return selected;
  };

  const runExport = async (
    kind: ExportKind,
    getContents: () => Promise<string>,
    defaultPath: string,
    filters: { name: string; extensions: string[] }[],
    successKey: string,
  ) => {
    const location = await run(async () => {
      const contents = await getContents();
      return writeExport(kind, contents, defaultPath, filters);
    });
    if (!location) return;
    setNotice({ kind: "success", text: `${t(successKey)} ${t("exportedTo")} ${location}` });
    setExportOpen(false);
  };

  const exportCopy = () =>
    runExport(
      "vault",
      Api.exportVaultCopy,
      "passdroid-copy.pdvault",
      [{ name: t("vaultFile"), extensions: ["pdvault"] }],
      "copyExported",
    );

  const exportLegacyXml = () =>
    runExport(
      "xml",
      Api.exportLegacyXml,
      "passdroid-export.xml",
      [{ name: "XML", extensions: ["xml"] }],
      "xmlExported",
    );

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
    // Show where the password landed: back to entries with the editor open.
    showEntries();
    setEditing(true);
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

  const openSettings = () => {
    setVaultView("settings");
    setEditing(false);
  };

  const showEntries = () => {
    setVaultView("entries");
    setEditing(false);
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

  // Handle a scanned QR code: parse payload and prompt for master password
  const handleQrScan = (text: string) => {
    setQrScannerOpen(false);
    const config = parseQrPayload(text);
    if (!config) {
      setNotice({ kind: "error", text: t("qrInvalidPayload") });
      return;
    }
    setQrLinkConfig(config);
    setQrLinkPassword("");
  };

  const finishQrLink = async (event: FormEvent) => {
    event.preventDefault();
    if (!qrLinkConfig) return;
    if (!qrLinkPassword) {
      setNotice({ kind: "error", text: t("err_master_password_incorrect") });
      return;
    }

    const config = qrLinkConfig;
    const password = qrLinkPassword;

    let path: string;
    const name = config.remoteFile.replace(/\.[^.]+$/, "") || "passdroid";
    if (isAndroid) {
      try {
        path = await androidVaultPath(name);
      } catch {
        setNotice({ kind: "error", text: t("err_unknown") });
        return;
      }
    } else {
      try {
        const base = await appLocalDataDir();
        const dir = await join(base, "vaults");
        await mkdir(dir, { recursive: true });
        path = await join(dir, config.remoteFile);
      } catch {
        setNotice({ kind: "error", text: t("err_unknown") });
        return;
      }
    }

    const success = await run(async () => {
      // 1. Download vault from FTP
      const contents = await Api.downloadFtpVault(config);
      // 2. Unlock & verify master password
      const status = await Api.unlockVault(contents, password);
      // 3. Save local vault file
      await writeTextFile(path, contents);
      // 4. Update sync config inside vault
      await Api.setSyncConfig(config).catch(() => {});
      return { path, status };
    }, "qrVaultLinked");

    if (success) {
      setVaultPath(success.path);
      setVaultStatus(success.status);
      rememberVault(success.path);
      cacheVaultIcon(success.path, success.status.icon);
      setSyncBadge(success.path, "sync");
      const loaded = await Api.listEntries().catch(() => []);
      setEntries(loaded);
      setSyncConfig(config);
      setSyncForm(config);
      setQrLinkConfig(null);
      setQrLinkPassword("");
      setDraft(emptyEntry());
      setSelectedId("");
      setEditing(false);
      setVaultView("entries");
      setScreen("vault");
    }
  };

  // The custom title bar replaces the native one on desktop only. The user agent
  // check avoids showing it for a frame on Android before isAndroid resolves.
  const showTitleBar = !isAndroid && !/android/i.test(navigator.userAgent);

  const startNewEntry = () => {
    setSelectedId("");
    setDraft(emptyEntry());
    setVaultView("entries");
    setChangePasswordForm({ oldPassword: "", newPassword: "", repeatPassword: "" });
    setEditing(true);
  };

  // Back to the saved version of the entry (or an empty one) and close the
  // full-screen editor on narrow screens.
  const discardChanges = () => {
    setDraft(entries.find((entry) => entry.id === selectedId) ?? emptyEntry());
    setEditing(false);
  };

  const hasRecents = preferences.recentVaults.length > 0;
  const draftStrength = passwordStrength(draft.password);
  const draftTone = strengthTone(draftStrength);
  const syncing = syncState === "syncing";
  const railCollapsed = preferences.railCollapsed === true;
  const notesView: NotesView = preferences.notesView === "preview" ? "preview" : "edit";
  const syncStatus: { tone: string; text: string } = !syncConfig?.enabled
    ? { tone: "", text: t("syncLocalOnly") }
    : syncing
      ? { tone: "warn", text: t("syncing") }
      : syncState === "error"
        ? { tone: "bad", text: t("syncFailed") }
        : syncState === "ok" && lastSyncAt
          ? {
              tone: "ok",
              text: t("syncedAt", {
                time: new Intl.DateTimeFormat(resolved, { timeStyle: "short" }).format(lastSyncAt),
              }),
            }
          : { tone: "", text: t("syncStatusIdle") };
  const modifiedAt = draft.updatedAt ? new Date(draft.updatedAt) : null;
  const modifiedText =
    modifiedAt && !Number.isNaN(modifiedAt.getTime())
      ? t("modifiedOn", {
          date: new Intl.DateTimeFormat(resolved, { dateStyle: "medium", timeStyle: "short" }).format(modifiedAt),
        })
      : "";
  const entryCount = `${entries.length} ${entries.length === 1 ? t("entry") : t("entries")}`;
  const vaultIconKey = vaultStatus?.icon || DEFAULT_VAULT_ICON;

  return (
    <div className={`app-shell${showTitleBar ? " has-titlebar" : ""}`}>
      {showTitleBar && (
        <TitleBar title={t("appName")}>
          {screen === "vault" && <span className="pill line titlebar-vault">{vaultName(vaultPath)}</span>}
        </TitleBar>
      )}

      {screen === "start" && (
        <main className="start-layout">
          <div className="start-body">
            <section className="hero">
              <img className="hero-logo" src={appIcon} alt="" width={64} height={64} />
              <div>
                <span className="eyebrow">{t("appTagline")}</span>
                <h1>{t("appName")}</h1>
              </div>
            </section>

            {hasRecents ? (
              <section>
                <div className="sechead">
                  <h3 className="eyebrow">{t("recentVaults")}</h3>
                  <span className="pill line">{t("vaultsCount", { count: preferences.recentVaults.length })}</span>
                </div>
                <div className="card recent-list">
                  {preferences.recentVaults.map((path) => {
                    const badge = vaultSyncBadges[path];
                    return (
                      <div className="recent-row" key={path}>
                        <button className="recent-open" type="button" onClick={() => openRecent(path)}>
                          <span className="av sq" style={hueStyle(path)}>
                            <VaultGlyph icon={getVaultIcon(path)} size={20} />
                          </span>
                          <span className="recent-text">
                            <span className="recent-name">{vaultName(path)}</span>
                            <span className="recent-path">{shortPath(path)}</span>
                          </span>
                          {badge === "sync" && (
                            <span className="pill ok">
                              <span className="dot ok" aria-hidden />
                              {t("badgeSync")}
                            </span>
                          )}
                          {badge === "local" && <span className="pill line">{t("badgeLocal")}</span>}
                          {badge === "pending" && <span className="pill warn">{t("badgePending")}</span>}
                        </button>
                        <button
                          className="icon-button"
                          type="button"
                          onClick={() => setRemovePromptPath(path)}
                          title={t("removeFromList")}
                          aria-label={t("removeFromList")}
                        >
                          <Trash2 size={16} aria-hidden />
                        </button>
                        <ChevronRight className="recent-chevron" size={16} aria-hidden />
                      </div>
                    );
                  })}
                </div>
              </section>
            ) : (
              <section className="card start-empty">
                <span className="tile xl">
                  <ShieldCheck size={28} aria-hidden />
                </span>
                <h2>{t("startEmptyTitle")}</h2>
                <p className="hint">{t("startEmptyBody")}</p>
                <button className="primary-button" type="button" onClick={() => setCreateOpen(true)} disabled={busy}>
                  <Plus size={18} aria-hidden />
                  {t("newVault")}
                </button>
              </section>
            )}

            <div className={`start-actions${hasRecents ? "" : " two"}`}>
              {hasRecents && (
                <button className="primary-button" type="button" onClick={() => setCreateOpen(true)} disabled={busy}>
                  <Plus size={18} aria-hidden />
                  {t("newVault")}
                </button>
              )}
              <button className="secondary-button" type="button" onClick={chooseVaultForOpen} disabled={busy}>
                {isAndroid ? <Import size={18} aria-hidden /> : <FolderOpen size={18} aria-hidden />}
                {isAndroid ? t("importVault") : t("openFile")}
              </button>
              <button className="secondary-button" type="button" onClick={() => setQrScannerOpen(true)} disabled={busy}>
                <QrCode size={18} aria-hidden />
                {t("qrLinkShort")}
              </button>
            </div>
            {isAndroid && <p className="hint center">{t("importAndroidHint")}</p>}

            <p className="fineprint">
              <ShieldCheck size={14} aria-hidden />
              {t("startFootnote")}
            </p>
          </div>
        </main>
      )}

      {screen === "unlock" && (
        <main className="unlock-layout">
          <form
            className="unlock-body"
            onSubmit={unlockVault}
            onFocus={(event) => {
              // The soft keyboard resizes the viewport a moment after focus: bring the button into view.
              const form = event.currentTarget;
              window.setTimeout(() => {
                form.querySelector<HTMLElement>("button[type=submit]")?.scrollIntoView({ block: "nearest" });
              }, 300);
            }}
          >
            <div className="knob">
              <Lock size={40} strokeWidth={2.5} aria-hidden />
            </div>
            <div className="unlock-head">
              <span className="eyebrow">{t("lockedEyebrow")}</span>
              <h2>{vaultName(vaultPath)}</h2>
              <p className="unlock-path">{shortPath(vaultPath)}</p>
            </div>
            <div className="unlock-form">
              <PasswordInput
                label={t("masterPassword")}
                value={unlockPassword}
                onChange={(value) => {
                  setUnlockPassword(value);
                  if (unlockError) setUnlockError("");
                }}
                autoFocus
                leadIcon
                error={unlockError}
              />
              <button className="primary-button lg" type="submit" disabled={busy}>
                <LockOpen size={18} aria-hidden />
                {t("unlock")}
              </button>
              <button
                className="ghost-button"
                type="button"
                onClick={() => {
                  setUnlockError("");
                  setScreen("start");
                }}
              >
                {t("cancel")}
              </button>
            </div>
            <div className="unlock-foot">
              <div className="status">
                <span className="dot warn" aria-hidden />
                {t("lockedFooter")}
              </div>
            </div>
          </form>
        </main>
      )}

      {screen === "vault" && (
        <main className={`vault-layout${railCollapsed ? " rail-collapsed" : ""}`}>
          <aside className="rail">
            <div className="rail-head">
              <span className="vault-tile" title={railCollapsed ? vaultName(vaultPath) : undefined}>
                <VaultGlyph icon={vaultIconKey} size={20} />
              </span>
              <div>
                <strong>{vaultName(vaultPath)}</strong>
                <span>{entryCount}</span>
              </div>
            </div>
            <nav className="nav" aria-label={t("navLabel")}>
              <NavButton
                active={vaultView === "entries"}
                icon={<List size={16} aria-hidden />}
                label={t("entriesTitle")}
                collapsed={railCollapsed}
                trailing={<span className="nav-count">{entries.length}</span>}
                onClick={showEntries}
              />
              <NavButton
                icon={<Sparkles size={16} aria-hidden />}
                label={t("generator")}
                collapsed={railCollapsed}
                onClick={() => setGeneratorOpen(true)}
              />
              {syncConfig?.enabled && (
                <NavButton
                  icon={<RefreshCw size={16} className={syncing ? "spin" : ""} aria-hidden />}
                  label={t("navSync")}
                  collapsed={railCollapsed}
                  title={syncStatus.text}
                  trailing={<span className={`dot ${syncStatus.tone}`} aria-hidden />}
                  onClick={manualSync}
                  disabled={busy || syncing}
                />
              )}
            </nav>
            <span className="eyebrow nav-label">{t("navData")}</span>
            <nav className="nav" aria-label={t("navData")}>
              <NavButton
                icon={<Download size={16} aria-hidden />}
                label={t("navImport")}
                collapsed={railCollapsed}
                onClick={() => setImportOpen(true)}
              />
              <NavButton
                icon={<Upload size={16} aria-hidden />}
                label={t("exportData")}
                collapsed={railCollapsed}
                onClick={() => setExportOpen(true)}
              />
              <NavButton
                active={vaultView === "settings"}
                icon={<Settings size={16} aria-hidden />}
                label={t("settings")}
                collapsed={railCollapsed}
                onClick={openSettings}
              />
            </nav>
            <div className="rail-spacer" />
            <div className="rail-foot">
              <div className="status" title={railCollapsed ? syncStatus.text : undefined}>
                <span className={`dot ${syncStatus.tone}`} aria-hidden />
                <span className="status-text">{syncStatus.text}</span>
              </div>
              <NavButton
                icon={railCollapsed ? <PanelLeftOpen size={16} aria-hidden /> : <PanelLeftClose size={16} aria-hidden />}
                label={railCollapsed ? t("railExpand") : t("railCollapse")}
                collapsed={railCollapsed}
                onClick={() => saveUiPreference({ railCollapsed: !railCollapsed })}
              />
              <button
                className="secondary-button full rail-lock"
                type="button"
                title={railCollapsed ? t("lock") : undefined}
                aria-label={t("lock")}
                onClick={lockVault}
              >
                <Lock size={16} aria-hidden />
                <span className="nav-text">{t("lock")}</span>
              </button>
            </div>
          </aside>

          {vaultView === "entries" && (
            <>
              <section className="listcol">
                <div className="mtop">
                  <span className="vault-tile">
                    <VaultGlyph icon={vaultIconKey} size={18} />
                  </span>
                  <div className="mtop-text">
                    <h2>{vaultName(vaultPath)}</h2>
                    <div className="status">
                      <span className={`dot ${syncStatus.tone}`} aria-hidden />
                      {syncStatus.text} · {entryCount}
                    </div>
                  </div>
                  {syncConfig?.enabled && (
                    <button
                      className={`icon-button round sync-button ${syncState}${syncing ? " pulse-ring" : ""}`}
                      type="button"
                      title={syncStatus.text}
                      aria-label={t("syncNow")}
                      onClick={manualSync}
                      disabled={busy || syncing}
                    >
                      <RefreshCw size={18} className={syncing ? "spin" : ""} aria-hidden />
                    </button>
                  )}
                  <button className="icon-button round" type="button" title={t("lock")} aria-label={t("lock")} onClick={lockVault}>
                    <Lock size={18} aria-hidden />
                  </button>
                </div>

                <div className="listhead">
                  <div className="list-top">
                    <h2>{t("entriesTitle")}</h2>
                    <button className="primary-button sm" type="button" onClick={startNewEntry}>
                      <Plus size={14} aria-hidden />
                      {t("newShort")}
                    </button>
                  </div>
                  <div className="search-box">
                    <Search size={16} aria-hidden />
                    <input
                      aria-label={t("search")}
                      placeholder={t("search")}
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                    />
                  </div>
                </div>

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
                      <span className="av" style={hueStyle(entry.title)} aria-hidden>
                        {initialOf(entry.title)}
                      </span>
                      <span className="tx">
                        <b>{entry.title}</b>
                        <span>{entry.username || entry.url}</span>
                      </span>
                      {(entry.conflict || weakIds.has(entry.id)) && (
                        <span className="bd">
                          {entry.conflict && <em className="pill bad">{t("conflict")}</em>}
                          {weakIds.has(entry.id) && <em className="pill warn">{t("strengthWeak")}</em>}
                        </span>
                      )}
                    </button>
                  ))}
                  {entries.length === 0 && <p className="empty-state">{t("emptyVault")}</p>}
                  {entries.length > 0 && filteredEntries.length === 0 && (
                    <p className="empty-state">{t("noSearchResults")}</p>
                  )}
                </div>

                <div className="listfoot">
                  <span className="status">{t("entriesShown", { shown: filteredEntries.length, total: entries.length })}</span>
                  <span className="status">
                    <ShieldCheck size={14} aria-hidden />
                    {t("encrypted")}
                  </span>
                </div>
              </section>

              <section className={`editor-panel ${editing ? "editing" : ""}`}>
                <form className="entry-form" onSubmit={saveEntry}>
                  <header className="ed-head">
                    <button className="icon-button ed-back" type="button" onClick={() => setEditing(false)} title={t("back")} aria-label={t("back")}>
                      <ChevronLeft size={22} aria-hidden />
                    </button>
                    <span className="av lg" style={hueStyle(draft.title)} aria-hidden>
                      {initialOf(draft.title)}
                    </span>
                    <div className="ed-title">
                      <span className="eyebrow">{draft.id ? t("editEntry") : t("newEntry")}</span>
                      <h2>{draft.title.trim() || t("untitled")}</h2>
                    </div>
                    {draftStrength > 0 && (
                      <span className={`pill ed-strength ${draftTone === "weak" ? "warn" : draftTone === "fair" ? "line" : "ok"}`}>
                        {draftTone === "weak" && <AlertTriangle size={12} aria-hidden />}
                        {draftTone === "strong" && <ShieldCheck size={12} aria-hidden />}
                        {t(strengthKey(draftStrength))}
                      </span>
                    )}
                    <button
                      className="icon-button danger ed-del-mobile"
                      type="button"
                      onClick={() => setDeletePromptOpen(true)}
                      disabled={!draft.id || busy}
                      title={t("delete")}
                      aria-label={t("delete")}
                    >
                      <Trash2 size={18} aria-hidden />
                    </button>
                  </header>

                  <div className="ed-body">
                    <div className="ed-fields">
                        <label className="span-2">
                          <span>{t("title")}</span>
                          <input
                            value={draft.title}
                            onChange={(event) => setDraft({ ...draft, title: event.target.value })}
                            autoComplete="off"
                          />
                        </label>
                        <label>
                          <span>{t("username")}</span>
                          <div className="password-row">
                            <input
                              value={draft.username}
                              onChange={(event) => setDraft({ ...draft, username: event.target.value })}
                              autoComplete="username"
                            />
                            <button className="icon-button" type="button" title={t("copy")} aria-label={t("copy")} onClick={() => copyToClipboard(draft.username)}>
                              <Copy size={16} aria-hidden />
                            </button>
                          </div>
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
                            <button
                              className="icon-button"
                              type="button"
                              title={showPassword ? t("hidePassword") : t("showPassword")}
                              aria-label={showPassword ? t("hidePassword") : t("showPassword")}
                              onClick={() => setShowPassword((value) => !value)}
                            >
                              {showPassword ? <EyeOff size={16} aria-hidden /> : <Eye size={16} aria-hidden />}
                            </button>
                            <button className="icon-button" type="button" title={t("copy")} aria-label={t("copy")} onClick={() => copyToClipboard(draft.password)}>
                              <Copy size={16} aria-hidden />
                            </button>
                            <button className="icon-button" type="button" title={t("generator")} aria-label={t("generator")} onClick={() => setGeneratorOpen(true)}>
                              <Sparkles size={16} aria-hidden />
                            </button>
                          </div>
                          <StrengthMeter level={draftStrength} showLabel />
                        </label>
                        <label className="span-2">
                          <span>{t("url")}</span>
                          <div className="password-row">
                            <Globe2 className="lead" size={16} aria-hidden />
                            <input
                              value={draft.url}
                              onChange={(event) => setDraft({ ...draft, url: event.target.value })}
                              autoComplete="url"
                            />
                            <button
                              className="icon-button"
                              type="button"
                              title={t("openUrl")}
                              aria-label={t("openUrl")}
                              onClick={openDraftUrl}
                              disabled={!isValidUrl(draft.url)}
                            >
                              <ExternalLink size={16} aria-hidden />
                            </button>
                          </div>
                        </label>
                    </div>
                    <div className="notes-field">
                      <div className="notes-head">
                        <label htmlFor="entry-notes">
                          <span>{t("notes")}</span>
                        </label>
                        <div className="segmented sm" role="group" aria-label={t("notesView")}>
                          <button
                            className={notesView === "edit" ? "active" : ""}
                            type="button"
                            aria-pressed={notesView === "edit"}
                            onClick={() => saveUiPreference({ notesView: "edit" })}
                          >
                            <Edit3 size={14} aria-hidden />
                            {t("notesEdit")}
                          </button>
                          <button
                            className={notesView === "preview" ? "active" : ""}
                            type="button"
                            aria-pressed={notesView === "preview"}
                            onClick={() => saveUiPreference({ notesView: "preview" })}
                          >
                            <Eye size={14} aria-hidden />
                            {t("notesPreview")}
                          </button>
                        </div>
                      </div>
                      {notesView === "edit" ? (
                        <textarea
                          id="entry-notes"
                          value={draft.notes}
                          placeholder={t("notesPlaceholder")}
                          onChange={(event) => setDraft({ ...draft, notes: event.target.value })}
                        />
                      ) : (
                        <div className="notes-preview" id="entry-notes" role="region" aria-label={t("notes")} tabIndex={0}>
                          {draft.notes.trim() ? (
                            <NotesBoundary key={draft.id} source={draft.notes}>
                              <Suspense fallback={null}>
                                <NotesMarkdown source={draft.notes} onOpenLink={openExternal} />
                              </Suspense>
                            </NotesBoundary>
                          ) : (
                            <p className="notes-empty">{t("notesPreviewEmpty")}</p>
                          )}
                        </div>
                      )}
                    </div>
                  </div>

                  <footer className="ed-foot">
                    <button className="primary-button" type="submit" disabled={busy}>
                      <Save size={18} aria-hidden />
                      {t("save")}
                    </button>
                    <button className="ghost-button" type="button" onClick={discardChanges}>
                      {t("discard")}
                    </button>
                    <span className="ed-spacer" />
                    {modifiedText && <span className="meta">{modifiedText}</span>}
                    <button
                      className="danger-button ed-del"
                      type="button"
                      onClick={() => setDeletePromptOpen(true)}
                      disabled={!draft.id || busy}
                      title={t("delete")}
                      aria-label={t("delete")}
                    >
                      <Trash2 size={16} aria-hidden />
                      <span className="ed-del-label">{t("delete")}</span>
                    </button>
                  </footer>
                </form>
              </section>

              <button className="fab" type="button" onClick={startNewEntry} title={t("newEntry")} aria-label={t("newEntry")}>
                <Plus size={24} strokeWidth={2.5} aria-hidden />
              </button>
            </>
          )}
          {vaultView === "settings" && (
            <section className="settings-panel" aria-labelledby="settings-title">
              <header className="settings-head">
                <span className="eyebrow">{t("appName")}</span>
                <h2 id="settings-title" tabIndex={-1} ref={settingsTitleRef}>
                  {t("settings")}
                </h2>
              </header>
              <div className="settings-tabs" role="tablist" aria-label={t("settings")}>
                <button
                  type="button"
                  role="tab"
                  id="settings-tab-general"
                  aria-selected={settingsTab === "general"}
                  aria-controls="settings-tabpanel"
                  className={`settings-tab ${settingsTab === "general" ? "active" : ""}`}
                  onClick={() => setSettingsTab("general")}
                >
                  <Sliders size={16} aria-hidden />
                  <span>{t("tabGeneral")}</span>
                </button>
                <button
                  type="button"
                  role="tab"
                  id="settings-tab-sync"
                  aria-selected={settingsTab === "sync"}
                  aria-controls="settings-tabpanel"
                  className={`settings-tab ${settingsTab === "sync" ? "active" : ""}`}
                  onClick={() => setSettingsTab("sync")}
                >
                  <Server size={16} aria-hidden />
                  <span>{t("tabSync")}</span>
                </button>
                <button
                  type="button"
                  role="tab"
                  id="settings-tab-security"
                  aria-selected={settingsTab === "security"}
                  aria-controls="settings-tabpanel"
                  className={`settings-tab ${settingsTab === "security" ? "active" : ""}`}
                  onClick={() => setSettingsTab("security")}
                >
                  <ShieldCheck size={16} aria-hidden />
                  <span>{t("tabSecurity")}</span>
                </button>
              </div>
              <div className="settings-body">
                <div className="settings-content" id="settings-tabpanel" role="tabpanel" aria-labelledby={`settings-tab-${settingsTab}`}>
                {settingsTab === "general" && (
                  <div className="stack-form">
                    <section>
                      <h3>{t("theme")}</h3>
                      <Segmented
                        value={themeMode}
                        options={[
                          { value: "system", label: t("system"), icon: <Monitor size={14} aria-hidden /> },
                          { value: "light", label: t("light"), icon: <Sun size={14} aria-hidden /> },
                          { value: "dark", label: t("dark"), icon: <Moon size={14} aria-hidden /> },
                        ]}
                        onChange={(theme) => setThemeMode(theme as ThemePreference)}
                      />
                    </section>
                    <section>
                      <h3>{t("language")}</h3>
                      <Segmented
                        value={language}
                        options={[
                          { value: "system", label: t("system"), icon: <Globe2 size={14} aria-hidden /> },
                          { value: "es", label: "Español" },
                          { value: "en", label: "English" },
                        ]}
                        onChange={(lang) => setLanguage(lang as Preferences["language"])}
                      />
                    </section>
                    <div className="card setting">
                      <span className="tile">
                        <VaultGlyph icon={vaultIconKey} size={18} />
                      </span>
                      <div className="setting-text">
                        <b>{t("vaultIcon")}</b>
                        <span>{t("vaultIconHint")}</span>
                      </div>
                      <button className="secondary-button sm" type="button" onClick={() => setIconPickerOpen(true)} disabled={busy}>
                        {t("chooseIcon")}
                      </button>
                    </div>
                  </div>
                )}

                {settingsTab === "sync" && (
                  <section className="stack-form">
                    <SettingToggle
                      icon={<RefreshCw size={18} aria-hidden />}
                      title={t("syncEnabled")}
                      hint={t("syncEnabledHint")}
                      checked={syncForm.enabled}
                      onChange={(enabled) => setSyncForm({ ...syncForm, enabled })}
                    />
                    <section>
                      <h3>{t("syncProtocol")}</h3>
                      <Segmented
                        value={syncForm.protocol === "ftps" ? "ftps" : "ftp"}
                        options={[
                          { value: "ftps", label: t("syncProtocolFtps"), icon: <ShieldCheck size={14} aria-hidden /> },
                          { value: "ftp", label: t("syncProtocolFtp"), icon: <LockOpen size={14} aria-hidden /> },
                        ]}
                        onChange={(protocol) => setSyncForm({ ...syncForm, protocol })}
                      />
                    </section>
                    <div className="grid3">
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
                    </div>
                    <div className="grid2">
                      <label>
                        <span>{t("syncUser")}</span>
                        <input
                          value={syncForm.username}
                          onChange={(event) => setSyncForm({ ...syncForm, username: event.target.value })}
                          autoComplete="off"
                        />
                      </label>
                      <PasswordInput
                        label={t("syncPassword")}
                        value={syncForm.password}
                        onChange={(password) => setSyncForm({ ...syncForm, password })}
                        autoComplete="new-password"
                      />
                    </div>
                    <div className="grid2">
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
                    {syncForm.protocol !== "ftps" && (
                      <p className="sync-warning">
                        <AlertTriangle size={16} aria-hidden />
                        <span>{t("syncPlainWarning")}</span>
                      </p>
                    )}
                    <div className="sync-actions">
                      <button className="secondary-button" type="button" onClick={testSyncConnection} disabled={busy}>
                        <Globe2 size={18} aria-hidden />
                        {t("syncTest")}
                      </button>
                      <button className="primary-button" type="button" onClick={saveSyncConfig} disabled={busy}>
                        <Save size={18} aria-hidden />
                        {t("save")}
                      </button>
                      <button
                        className="ghost-button"
                        type="button"
                        onClick={manualSync}
                        disabled={busy || syncing || !syncConfig?.enabled}
                      >
                        <RefreshCw size={18} aria-hidden />
                        {t("syncNow")}
                      </button>
                    </div>
                    {syncConfig?.enabled && (
                      <div className="card setting">
                        <span className="tile">
                          <QrCode size={18} aria-hidden />
                        </span>
                        <div className="setting-text">
                          <b>{t("qrLinkDevice")}</b>
                          <span>{t("qrHowBody")}</span>
                        </div>
                        <button className="secondary-button sm" type="button" onClick={() => setQrShowModalOpen(true)} disabled={busy}>
                          {t("qrShowCode")}
                        </button>
                      </div>
                    )}
                  </section>
                )}

                {settingsTab === "security" && (
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
                    >
                      <StrengthMeter level={passwordStrength(changePasswordForm.newPassword)} showLabel />
                    </PasswordInput>
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
                )}
                </div>
              </div>
            </section>
          )}

          <nav className="tabbar" aria-label={t("navLabel")}>
            <button
              className={`tab${vaultView === "entries" ? " active" : ""}`}
              type="button"
              aria-current={vaultView === "entries" ? "page" : undefined}
              onClick={showEntries}
            >
              <List size={20} aria-hidden />
              {t("entriesTitle")}
            </button>
            <button className="tab" type="button" onClick={() => setGeneratorOpen(true)}>
              <Sparkles size={20} aria-hidden />
              {t("generator")}
            </button>
            <button className="tab" type="button" onClick={() => setImportOpen(true)}>
              <Download size={20} aria-hidden />
              {t("navImport")}
            </button>
            <button className="tab" type="button" onClick={() => setExportOpen(true)}>
              <Upload size={20} aria-hidden />
              {t("exportData")}
            </button>
            <button
              className={`tab${vaultView === "settings" ? " active" : ""}`}
              type="button"
              aria-current={vaultView === "settings" ? "page" : undefined}
              onClick={openSettings}
            >
              <Settings size={20} aria-hidden />
              {t("settings")}
            </button>
          </nav>
        </main>
      )}

      {notice && (
        <Toast notice={notice} onClose={() => setNotice(null)} />
      )}

      {createOpen && (
        <Modal title={t("newVault")} eyebrow={t("appName")} onClose={closeCreate}>
          <form className="stack-form" onSubmit={createVault}>
            {isAndroid ? (
              <label>
                <span>{t("vaultName")}</span>
                <input
                  value={createName}
                  onChange={(event) => setCreateName(event.target.value)}
                  placeholder="passdroid"
                  autoComplete="off"
                  autoFocus
                />
              </label>
            ) : (
              <FilePickerRow label={t("vaultFile")} path={vaultPath} onPick={chooseVaultForCreate} t={t} />
            )}
            <PasswordInput label={t("masterPassword")} value={createPassword} onChange={setCreatePassword}>
              <StrengthMeter level={passwordStrength(createPassword)} showLabel />
            </PasswordInput>
            <PasswordInput label={t("repeatPassword")} value={createPasswordRepeat} onChange={setCreatePasswordRepeat} />
            <div className="modal-actions">
              <button className="ghost-button" type="button" onClick={closeCreate}>
                {t("cancel")}
              </button>
              <button className="primary-button" type="submit" disabled={busy}>
                <Save size={18} aria-hidden />
                {t("createVault")}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {generatorOpen && (
        <Modal title={t("generator")} onClose={closeGenerator}>
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
            <div className="card toggle-list">
              <Toggle label={t("uppercase")} checked={generatorOptions.uppercase} onChange={(uppercase) => setGeneratorOptions({ ...generatorOptions, uppercase })} />
              <Toggle label={t("lowercase")} checked={generatorOptions.lowercase} onChange={(lowercase) => setGeneratorOptions({ ...generatorOptions, lowercase })} />
              <Toggle label={t("numbers")} checked={generatorOptions.numbers} onChange={(numbers) => setGeneratorOptions({ ...generatorOptions, numbers })} />
              <Toggle label={t("symbols")} checked={generatorOptions.symbols} onChange={(symbols) => setGeneratorOptions({ ...generatorOptions, symbols })} />
            </div>
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
        <Modal title={t("importLegacy")} eyebrow={t("navData")} onClose={closeImport}>
          <form className="stack-form" onSubmit={previewImport}>
            <FilePickerRow label={t("chooseFile")} path={legacyPath} onPick={chooseLegacyFile} t={t} />
            <PasswordInput
              label={t("legacyPassword")}
              value={legacyPassword}
              onChange={setLegacyPassword}
            />
            <button className={importPreview ? "secondary-button" : "primary-button"} type="submit" disabled={busy}>
              <Import size={18} aria-hidden />
              {t("previewImport")}
            </button>
          </form>
          {importPreview && (
            <section className="import-preview">
              <div className="preview-head">
                <h3>{t("importedEntries")}</h3>
                <span className="pill line">
                  {importPreview.count > importPreview.entries.length
                    ? t("entriesShown", { shown: importPreview.entries.length, total: importPreview.count })
                    : importPreview.count}
                </span>
              </div>
              <div className="card preview-list">
                {importPreview.entries.map((entry, index) => (
                  <div className="preview-row" key={`${entry.title}-${index}`}>
                    <span className="av sm" style={hueStyle(entry.title)} aria-hidden>
                      {initialOf(entry.title)}
                    </span>
                    <span className="tx">
                      <b>{entry.title}</b>
                      <span>{entry.username || entry.url}</span>
                    </span>
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
        <Modal title={t("exportData")} eyebrow={t("navData")} onClose={() => setExportOpen(false)}>
          <div className="export-options">
            <button className="export-option" type="button" onClick={exportCopy} disabled={busy}>
              <span className="tile lg">
                <FileLock2 size={20} aria-hidden />
              </span>
              <div>
                <strong>{t("exportEncrypted")}</strong>
                <span>{t("exportEncryptedHint")}</span>
              </div>
              <span className="pill ok export-mark">{t("exportRecommended")}</span>
            </button>
            <button className="export-option danger" type="button" onClick={exportLegacyXml} disabled={busy}>
              <span className="tile lg">
                <FileText size={20} aria-hidden />
              </span>
              <div>
                <strong>{t("exportXmlPlain")}</strong>
                <span>{t("exportXmlWarning")}</span>
              </div>
              <span className="pill bad export-mark">{t("exportRisk")}</span>
            </button>
          </div>
          <p className="hint-line">
            <FolderOpen size={14} aria-hidden />
            {isAndroid ? t("exportLocationAndroid") : t("exportLocationDesktop")}
          </p>
        </Modal>
      )}

      {syncPrompt && (
        <Modal title={t("syncNewerTitle")} eyebrow={t("tabSync")} onClose={() => setSyncPrompt(null)}>
          <p className="hint">{t("syncNewerMessage")}</p>
          <button
            className="primary-button full"
            type="button"
            onClick={() => {
              setSyncPrompt(null);
              void manualSync();
            }}
            disabled={busy}
          >
            <Download size={18} aria-hidden />
            {t("syncDownload")}
          </button>
        </Modal>
      )}

      {iconPickerOpen && (
        <Modal title={t("chooseIcon")} onClose={() => setIconPickerOpen(false)}>
          <div className="icon-grid">
            {Object.keys(VAULT_ICONS).map((key) => (
              <button
                key={key}
                type="button"
                className={`icon-choice ${vaultIconKey === key ? "active" : ""}`}
                onClick={() => applyVaultIcon(key)}
                disabled={busy}
                aria-label={t(`vaultIcon_${key}`)}
                title={t(`vaultIcon_${key}`)}
              >
                <VaultGlyph icon={key} size={22} />
              </button>
            ))}
          </div>
        </Modal>
      )}

      {deletePromptOpen && (
        <Modal title={draft.title || t("untitled")} onClose={() => setDeletePromptOpen(false)}>
          <p className="hint">{t("deleteEntryConfirm")}</p>
          <div className="modal-actions">
            <button className="ghost-button" type="button" onClick={() => setDeletePromptOpen(false)}>
              {t("cancel")}
            </button>
            <button
              className="danger-button"
              type="button"
              disabled={busy}
              onClick={async () => {
                setDeletePromptOpen(false);
                await deleteCurrentEntry();
              }}
            >
              <Trash2 size={18} aria-hidden />
              {t("delete")}
            </button>
          </div>
        </Modal>
      )}

      {removePromptPath !== null && (
        <Modal title={vaultName(removePromptPath)} onClose={() => setRemovePromptPath(null)}>
          <p className="hint">{t("removeVaultConfirm")}</p>
          <div className="modal-actions">
            <button className="ghost-button" type="button" onClick={() => setRemovePromptPath(null)}>
              {t("cancel")}
            </button>
            <button
              className="danger-button"
              type="button"
              onClick={() => {
                removeRecent(removePromptPath);
                setRemovePromptPath(null);
              }}
            >
              <Trash2 size={18} aria-hidden />
              {t("removeFromList")}
            </button>
          </div>
        </Modal>
      )}

      {/* QR Scanner Modal */}
      <QrCameraScanner
        isOpen={qrScannerOpen}
        onScan={handleQrScan}
        onClose={() => setQrScannerOpen(false)}
      />

      {/* QR Show Modal (for sharing FTP config) */}
      {syncConfig && (
        <QrVaultModal
          isOpen={qrShowModalOpen}
          syncConfig={syncConfig}
          onClose={() => setQrShowModalOpen(false)}
        />
      )}

      {/* QR Link Password Prompt Modal */}
      {qrLinkConfig && (
        <Modal
          title={t("qrLinkViaQr")}
          eyebrow={t("tabSync")}
          onClose={() => {
            setQrLinkConfig(null);
            setQrLinkPassword("");
          }}
        >
          <form className="stack-form" onSubmit={finishQrLink}>
            <div className="vault-chip">
              <Server size={20} aria-hidden />
              <span>{qrLinkConfig.host} &bull; {qrLinkConfig.remoteFile}</span>
            </div>
            <p className="hint">{t("qrEnterMasterPassword")}</p>
            <PasswordInput
              label={t("masterPassword")}
              value={qrLinkPassword}
              onChange={setQrLinkPassword}
              autoFocus
            />
            <div className="modal-actions">
              <button
                className="ghost-button"
                type="button"
                onClick={() => {
                  setQrLinkConfig(null);
                  setQrLinkPassword("");
                }}
              >
                {t("cancel")}
              </button>
              <button className="primary-button" type="submit" disabled={busy}>
                <Download size={18} aria-hidden />
                {t("syncDownload")}
              </button>
            </div>
          </form>
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
  autoComplete = "current-password",
  leadIcon,
  error,
  children,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoFocus?: boolean;
  autoComplete?: string;
  // Key icon before the field (unlock screen).
  leadIcon?: boolean;
  // Inline error: red border and text under the field, instead of a toast.
  error?: string;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);
  return (
    <label>
      <span>{label}</span>
      <div className={`password-row${error ? " invalid" : ""}`}>
        {leadIcon && <KeyRound className="lead" size={16} aria-hidden />}
        <input
          type={visible ? "text" : "password"}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          autoFocus={autoFocus}
          autoComplete={autoComplete}
          aria-invalid={error ? true : undefined}
        />
        <button
          className="icon-button"
          type="button"
          onClick={() => setVisible((current) => !current)}
          title={visible ? t("hidePassword") : t("showPassword")}
          aria-label={visible ? t("hidePassword") : t("showPassword")}
        >
          {visible ? <EyeOff size={16} aria-hidden /> : <Eye size={16} aria-hidden />}
        </button>
      </div>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      {children}
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
  t: (key: string) => string;
}) {
  return (
    <label>
      <span>{label}</span>
      <div className="file-row">
        <input value={path} readOnly />
        <button className="icon-button" type="button" onClick={onPick} title={t("chooseVault")} aria-label={t("chooseVault")}>
          <FolderOpen size={16} aria-hidden />
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
      <input className="switch" type="checkbox" role="switch" checked={checked} onChange={(event) => onChange(event.target.checked)} />
    </label>
  );
}

// A setting rendered as a card: icon tile, title + description, switch at the right.
function SettingToggle({
  icon,
  title,
  hint,
  checked,
  onChange,
}: {
  icon: ReactNode;
  title: string;
  hint: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="card setting">
      <span className="tile">{icon}</span>
      <span className="setting-text">
        <b>{title}</b>
        <span>{hint}</span>
      </span>
      <input className="switch" type="checkbox" role="switch" checked={checked} onChange={(event) => onChange(event.target.checked)} />
    </label>
  );
}

function Segmented({
  value,
  options,
  onChange,
}: {
  value: string;
  options: { value: string; label: string; icon?: ReactNode }[];
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

// Left-rail navigation item (desktop).
function NavButton({
  icon,
  label,
  active,
  trailing,
  title,
  collapsed,
  disabled,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  active?: boolean;
  trailing?: ReactNode;
  title?: string;
  // Icon-only rail: the label is hidden, so it moves to aria-label and the tooltip.
  collapsed?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className={`nav-item${active ? " active" : ""}`}
      type="button"
      aria-current={active ? "page" : undefined}
      aria-label={collapsed ? label : undefined}
      title={collapsed ? (title ? `${label}: ${title}` : label) : title}
      disabled={disabled}
      onClick={onClick}
    >
      {icon}
      <span className="nav-text">{label}</span>
      {trailing}
    </button>
  );
}

// Four-segment strength bar. An empty password renders nothing.
function StrengthMeter({ level, showLabel }: { level: StrengthLevel; showLabel?: boolean }) {
  const { t } = useTranslation();
  if (level === 0) return null;
  return (
    <div className={`strength ${strengthTone(level)}`}>
      <div className="meter" aria-hidden>
        {[1, 2, 3, 4].map((step) => (
          <i key={step} className={step <= level ? "on" : ""} />
        ))}
      </div>
      {showLabel && <span className="meter-label">{t(strengthKey(level))}</span>}
    </div>
  );
}

function formatError(error: unknown, t: (key: string) => string) {
  const raw = typeof error === "string" ? error : error instanceof Error ? error.message : "unknown";
  const key = `err_${raw}`;
  const translated = t(key);
  return translated === key ? t("err_unknown") : translated;
}

export default App;
