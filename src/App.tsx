import {
  Copy,
  Download,
  Eye,
  EyeOff,
  FileLock2,
  FolderOpen,
  Globe2,
  Import,
  KeyRound,
  Lock,
  Moon,
  Plus,
  Save,
  Search,
  Settings,
  Sparkles,
  Sun,
  Trash2,
  Wand2,
} from "lucide-react";
import { FormEvent, ReactNode, useEffect, useMemo, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import Api, {
  GeneratePasswordOptions,
  ImportPreview,
  Preferences,
  VaultEntry,
  VaultStatus,
} from "./api";
import { createTranslator, resolveLanguage, ThemePreference, TranslationKey } from "./i18n";

type Screen = "start" | "unlock" | "vault";
type Notice = { kind: "success" | "error"; text: string } | null;

const defaultPreferences: Preferences = { theme: "system", language: "system" };

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
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [generatorOpen, setGeneratorOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
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

  const chooseVaultForCreate = async () => {
    const selected = await save({
      defaultPath: "passdroid.pdvault",
      filters: [{ name: t("vaultFile"), extensions: ["pdvault"] }],
    });
    if (selected) setVaultPath(selected);
  };

  const chooseVaultForOpen = async () => {
    const selected = await open({
      multiple: false,
      filters: [{ name: t("vaultFile"), extensions: ["pdvault"] }],
    });
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

    const status = await run(
      () => Api.createVault(vaultPath, createPassword),
      "vaultCreated",
    );
    if (status) {
      setVaultStatus(status);
      setEntries([]);
      setDraft(emptyEntry());
      setSelectedId("");
      setCreatePassword("");
      setCreatePasswordRepeat("");
      setScreen("vault");
    }
  };

  const unlockVault = async (event: FormEvent) => {
    event.preventDefault();
    const status = await run(
      () => Api.unlockVault(vaultPath, unlockPassword),
      "vaultUnlocked",
    );
    if (status) {
      setVaultStatus(status);
      const loaded = await run(() => Api.listEntries());
      setEntries(loaded ?? []);
      setUnlockPassword("");
      setDraft(emptyEntry());
      setSelectedId("");
      setScreen("vault");
    }
  };

  const lockVault = async () => {
    const ok = await run(() => Api.lockVault(), "vaultLocked");
    if (ok !== null) {
      setEntries([]);
      setDraft(emptyEntry());
      setSelectedId("");
      setScreen("unlock");
    }
  };

  const saveEntry = async (event: FormEvent) => {
    event.preventDefault();
    if (!draft.title.trim()) {
      setNotice({ kind: "error", text: t("requiredTitle") });
      return;
    }
    const existingId = draft.id;
    const knownIds = new Set(entries.map((entry) => entry.id));
    const savedEntries = await run(() => Api.upsertEntry(draft), "saved");
    if (savedEntries) {
      setEntries(savedEntries);
      // Updates keep their id; a create is the entry whose id is new in the
      // returned list (the backend assigns the UUID and trims the title).
      const created = savedEntries.find((entry) => !knownIds.has(entry.id));
      const nextId = existingId || created?.id || "";
      if (nextId) setSelectedId(nextId);
    }
  };

  const deleteCurrentEntry = async () => {
    if (!draft.id) return;
    const savedEntries = await run(() => Api.deleteEntry(draft.id), "entryDeleted");
    if (savedEntries) {
      setEntries(savedEntries);
      setSelectedId("");
      setDraft(emptyEntry());
    }
  };

  const copyPassword = async () => {
    if (!draft.password) return;
    await navigator.clipboard.writeText(draft.password);
    setNotice({ kind: "success", text: t("copied") });
  };

  const exportCopy = async () => {
    const selected = await save({
      defaultPath: "passdroid-copy.pdvault",
      filters: [{ name: t("vaultFile"), extensions: ["pdvault"] }],
    });
    if (selected) {
      await run(() => Api.exportVaultCopy(selected), "copyExported");
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
    const status = await run(
      () =>
        Api.changeMasterPassword(
          changePasswordForm.oldPassword,
          changePasswordForm.newPassword,
        ),
      "passwordChanged",
    );
    if (status) {
      setVaultStatus(status);
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
    const selected = await open({
      multiple: false,
      filters: [{ name: "Passdroid", extensions: ["xml", "db"] }],
    });
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
    const preview = await run(
      () => Api.importLegacyPreview(legacyPath, legacyPassword),
      "importReady",
    );
    if (preview) setImportPreview(preview);
  };

  const commitImport = async () => {
    if (!importPreview) {
      setNotice({ kind: "error", text: t("requiredImportPreview") });
      return;
    }
    const savedEntries = await run(
      () => Api.importLegacyCommit(importPreview.importId),
      "importDone",
    );
    if (savedEntries) {
      setEntries(savedEntries);
      closeImport();
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
          <section className="brand-panel">
            <div className="brand-mark">
              <FileLock2 size={42} aria-hidden />
            </div>
            <h1>{t("appName")}</h1>
          </section>

          <section className="start-actions">
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

            <div className="panel">
              <div className="panel-heading">
                <FolderOpen size={22} aria-hidden />
                <h2>{t("existingVault")}</h2>
              </div>
              <button className="secondary-button full" type="button" onClick={chooseVaultForOpen} disabled={busy}>
                <FolderOpen size={18} aria-hidden />
                {t("openVault")}
              </button>
            </div>
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
            <div className="path-chip">{vaultPath}</div>
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
              <button className="icon-button" type="button" title={t("generator")} aria-label={t("generator")} onClick={() => setGeneratorOpen(true)}>
                <Wand2 size={19} aria-hidden />
              </button>
              <button className="icon-button" type="button" title={t("importLegacy")} aria-label={t("importLegacy")} onClick={() => setImportOpen(true)}>
                <Import size={19} aria-hidden />
              </button>
              <button className="icon-button" type="button" title={t("exportCopy")} aria-label={t("exportCopy")} onClick={exportCopy}>
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
                    onClick={() => setSelectedId(entry.id)}
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

            <section className="editor-panel">
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
        <Modal title={t("settings")} onClose={closeSettings}>
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
        <Modal title={t("importLegacy")} onClose={closeImport}>
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
    </div>
  );
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
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  return (
    <div className="modal-backdrop" role="presentation">
      <section className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <header>
          <h2>{title}</h2>
          <button className="icon-button" type="button" onClick={onClose} aria-label={title} title={title}>
            <Lock size={18} aria-hidden />
          </button>
        </header>
        {children}
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
