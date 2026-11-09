/**
 * Backend falso en memoria para los tests de frontend.
 *
 * Implementa los 25 comandos de `src-tauri/src/lib.rs` y los comandos de plugin
 * que usa la UI (dialog, fs, path, opener, y window/event para TitleBar), copiando
 * la semántica de `src-tauri/src/vault.rs`, `preferences.rs`, `export.rs` y
 * `crates/passdroid-core`.
 *
 * NO es criptografía real: el "fichero" .pdvault es JSON en claro con la
 * contraseña maestra. Basta para el contrato que ve la UI (contraseña correcta
 * o incorrecta, revisión, tombstones, bloqueo). Nunca usar con datos reales.
 *
 * Como Tauri, los errores se lanzan como `string` (el `Err(String)` de Rust llega
 * como rechazo con ese mismo valor), así que la UI los traduce igual.
 */
import { BaseDirectory } from "@tauri-apps/api/path";
import type {
  EntriesSnapshot,
  ExportKind,
  GeneratePasswordOptions,
  ImportPreview,
  Preferences,
  SyncCheck,
  SyncConfig,
  VaultEntry,
  VaultSnapshot,
  VaultStatus,
} from "../api";

export const FAKE_VAULT_FORMAT = "passdroid-fake-vault";
export const FAKE_APP_LOCAL_DATA = "/fake/app-local-data";
export const FAKE_DEFAULT_VAULT_PATH = "/vaults/passdroid.pdvault";

// passdroid-core: validate_password (chars().count() < 8).
const MIN_PASSWORD_CHARS = 8;
// passdroid-core: generate_password clamp(8, 256).
const MIN_GENERATED_LENGTH = 8;
const MAX_GENERATED_LENGTH = 256;
const LEGACY_PREVIEW_LIMIT = 50;
const FAKE_APP_VERSION = "fake";

const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const LOWER = "abcdefghijkmnopqrstuvwxyz";
const DIGITS = "23456789";
const SYMBOLS = "!@#$%^&*()-_=+[]{};:,.?";

export interface FakeInvokeOptions {
  headers?: Record<string, string>;
}

export interface FakeEntrySeed {
  id?: string;
  title: string;
  username?: string;
  password?: string;
  url?: string;
  notes?: string;
  deletedAt?: string | null;
}

export interface FakeVaultSeed {
  /** Ruta del fichero en el sistema de ficheros en memoria. */
  path?: string;
  masterPassword: string;
  entries?: FakeEntrySeed[];
  /** Revisión guardada en el fichero. Por defecto 1 (como tras crear y guardar). */
  revision?: number;
  icon?: string;
  sync?: Partial<SyncConfig>;
}

export interface FakeBackendOptions {
  preferences?: Partial<Preferences>;
  /** Reloj inyectable para fijar createdAt/updatedAt en los tests. */
  now?: () => string;
}

/** Estado observable para los asserts de los tests. */
export interface FakeSnapshot {
  unlocked: boolean;
  vaultId: string | null;
  revision: number | null;
  /** Todas las entradas, incluidas las borradas (tombstones). */
  entries: VaultEntry[];
  /** Entradas visibles, ordenadas igual que Rust (título y usuario, sin distinguir mayúsculas). */
  visibleEntries: VaultEntry[];
  icon: string | null;
  preferences: Preferences;
  files: Record<string, string>;
  dirs: string[];
  openedUrls: string[];
}

interface Envelope {
  format: string;
  vaultId: string;
  password: string;
  revision: number;
  entries: VaultEntry[];
  settings: Record<string, unknown>;
}

interface Session {
  vaultId: string;
  password: string;
  revision: number;
  entries: VaultEntry[];
  settings: Record<string, unknown>;
}

function defaultPreferences(): Preferences {
  // Mismos valores que Preferences::default en src-tauri/src/models.rs.
  return {
    theme: "system",
    language: "system",
    recentVaults: [],
    vaultIcons: {},
    railCollapsed: false,
    notesView: "edit",
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function toBytes(value: unknown): Uint8Array {
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (Array.isArray(value)) return Uint8Array.from(value as number[]);
  throw new Error("FakeBackend: se esperaban bytes para el fichero");
}

function assertPasswordLength(password: string): void {
  if (Array.from(password).length < MIN_PASSWORD_CHARS) {
    throw "master_password_too_short";
  }
}

function normalizeSync(input: Partial<SyncConfig>): SyncConfig {
  // Mismos valores por defecto que los #[serde(default)] de SyncConfig en Rust.
  return {
    enabled: input.enabled ?? false,
    protocol: input.protocol ?? "",
    host: input.host ?? "",
    port: input.port ?? 21,
    username: input.username ?? "",
    password: input.password ?? "",
    remoteDir: input.remoteDir ?? "",
    remoteFile: input.remoteFile ?? "",
  };
}

function readSyncConfig(settings: Record<string, unknown>): SyncConfig | null {
  const raw = settings.sync;
  if (!raw || typeof raw !== "object") return null;
  return normalizeSync(raw as Partial<SyncConfig>);
}

function iconOf(settings: Record<string, unknown>): string {
  return typeof settings.icon === "string" ? settings.icon : "";
}

function compareByTitleThenUser(a: VaultEntry, b: VaultEntry): number {
  const titleA = a.title.toLowerCase();
  const titleB = b.title.toLowerCase();
  if (titleA !== titleB) return titleA < titleB ? -1 : 1;
  const userA = a.username.toLowerCase();
  const userB = b.username.toLowerCase();
  if (userA === userB) return 0;
  return userA < userB ? -1 : 1;
}

function randomIndex(length: number): number {
  // Muestreo por rechazo, como random_index en passdroid-core.
  const range = 0x100000000;
  const limit = range - (range % length);
  const buffer = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buffer);
    if (buffer[0] < limit) return buffer[0] % length;
  }
}

/** Réplica de passdroid-core::generate_password. */
export function generatePassword(options: GeneratePasswordOptions): string {
  if (!Number.isFinite(options.length)) throw "password_generator_failed";
  const length = Math.min(
    MAX_GENERATED_LENGTH,
    Math.max(MIN_GENERATED_LENGTH, Math.trunc(options.length)),
  );

  const groups: string[] = [];
  if (options.uppercase) groups.push(UPPER);
  if (options.lowercase) groups.push(LOWER);
  if (options.numbers) groups.push(DIGITS);
  if (options.symbols) groups.push(SYMBOLS);
  if (groups.length === 0) throw "password_generator_empty_charset";

  const chars = groups.map((group) => group[randomIndex(group.length)]);
  const all = groups.join("");
  while (chars.length < length) {
    chars.push(all[randomIndex(all.length)]);
  }
  for (let index = chars.length - 1; index > 0; index -= 1) {
    const swap = randomIndex(index + 1);
    [chars[index], chars[swap]] = [chars[swap], chars[index]];
  }
  return chars.join("");
}

function escapeXmlAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function cdataField(tag: string, value: string): string {
  if (!value) return "";
  // Como push_cdata_field: partir "]]>" para que no cierre la sección CDATA.
  const escaped = value.split("]]>").join("]]>]]><![CDATA[");
  return `    <${tag}><![CDATA[${escaped}]]></${tag}>\n`;
}

/** Réplica de legacy::entries_to_legacy_xml (XML en claro). */
function entriesToLegacyXml(entries: VaultEntry[], version: string): string {
  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
  xml += `<passdroid version="${escapeXmlAttr(version)}">\n`;
  for (const entry of entries) {
    xml += `  <system name="${escapeXmlAttr(entry.title)}">\n`;
    xml += cdataField("username", entry.username);
    xml += cdataField("password", entry.password);
    xml += cdataField("note", entry.notes);
    xml += cdataField("url", entry.url);
    xml += "  </system>\n";
  }
  xml += "</passdroid>\n";
  return xml;
}

function importedEntry(
  title: string,
  username: string,
  password: string,
  notes: string,
  url: string,
): VaultEntry {
  // Réplica de VaultEntry::imported: sin id ni fechas; el commit las asigna.
  return {
    id: "",
    title,
    username,
    password,
    url,
    notes,
    createdAt: "",
    updatedAt: "",
    deletedAt: null,
    conflict: false,
  };
}

/** Réplica de legacy::parse_xml. */
function parseLegacyXml(xml: string): VaultEntry[] {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.getElementsByTagName("parsererror").length > 0) {
    throw "legacy_xml_invalid";
  }
  const root = doc.documentElement;
  if (root.tagName !== "passdroid") throw "legacy_xml_invalid_root";

  const childText = (node: Element, tag: string): string => {
    const child = Array.from(node.children).find((element) => element.tagName === tag);
    return child?.textContent ?? "";
  };

  return Array.from(root.children)
    .filter((element) => element.tagName === "system")
    .map((system) =>
      importedEntry(
        system.getAttribute("name") ?? "",
        childText(system, "username"),
        childText(system, "password"),
        childText(system, "note"),
        childText(system, "url"),
      ),
    );
}

/** Réplica de legacy::import_legacy_entries_from_bytes, sin soporte de cifrado. */
function parseLegacyBytes(name: string, bytes: Uint8Array, password: string | undefined): VaultEntry[] {
  const isSqlite =
    startsWithAscii(bytes, "SQLite format 3") || name.toLowerCase().endsWith(".db");
  const isEncryptedExport = startsWithAscii(bytes, "sqt");
  if (isSqlite || isEncryptedExport) {
    if (!password) throw "legacy_password_required";
    throw new Error(
      "FakeBackend: los formatos legacy cifrados (sqt / SQLite) no están implementados; solo XML en claro",
    );
  }
  let xml: string;
  try {
    xml = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw "legacy_file_not_utf8";
  }
  return parseLegacyXml(xml);
}

function startsWithAscii(bytes: Uint8Array, prefix: string): boolean {
  if (bytes.length < prefix.length) return false;
  for (let index = 0; index < prefix.length; index += 1) {
    if (bytes[index] !== prefix.charCodeAt(index)) return false;
  }
  return true;
}

/**
 * Réplica de export::verify: el contenido no puede estar vacío y debe ser del
 * formato que dice su tipo. En el fake, el "vault" es el envelope JSON del fake
 * (su `format`), no el de Rust (magic + payload).
 */
function verifyExport(kind: ExportKind, contents: string): null {
  if (contents.trim() === "") throw "export_verify_failed";
  if (kind === "vault") {
    let parsed: { format?: unknown } | null;
    try {
      parsed = JSON.parse(contents) as { format?: unknown } | null;
    } catch {
      throw "export_verify_failed";
    }
    if (parsed?.format !== FAKE_VAULT_FORMAT) throw "export_verify_failed";
    return null;
  }
  if (kind !== "xml") throw new Error(`FakeBackend: tipo de exportación desconocido: ${String(kind)}`);
  const doc = new DOMParser().parseFromString(contents, "application/xml");
  if (doc.getElementsByTagName("parsererror").length > 0) throw "export_verify_failed";
  if (doc.documentElement?.tagName !== "passdroid") throw "export_verify_failed";
  return null;
}

/**
 * Réplica de export_save_android en escritorio: primero verifica (como Rust) y
 * después falla, porque el guardado sin selector solo existe en Android.
 */
function exportSaveAndroid(kind: ExportKind, contents: string): never {
  verifyExport(kind, contents);
  throw "export_unsupported";
}

export class FakeBackend {
  /** Registro de todas las llamadas recibidas, en orden. */
  readonly calls: { cmd: string; args: unknown }[] = [];

  private readonly now: () => string;
  private preferences: Preferences;
  private session: Session | null = null;
  private readonly files = new Map<string, string>();
  private readonly dirs = new Set<string>();
  private readonly pendingImports = new Map<string, VaultEntry[]>();
  private readonly openedUrls: string[] = [];
  private openDialogResult: string | null = null;
  private saveDialogResult: string | null = null;
  private windowMaximized = false;
  private counter = 0;

  constructor(options: FakeBackendOptions = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.preferences = { ...defaultPreferences(), ...options.preferences };
  }

  // ---------------------------------------------------------------------------
  // Preparación de estado (solo para tests)
  // ---------------------------------------------------------------------------

  /** Escribe un .pdvault sembrado en el sistema de ficheros en memoria. */
  seedVault(seed: FakeVaultSeed): string {
    const path = seed.path ?? FAKE_DEFAULT_VAULT_PATH;
    const settings: Record<string, unknown> = {};
    if (seed.icon) settings.icon = seed.icon;
    if (seed.sync) settings.sync = normalizeSync(seed.sync);
    const envelope: Envelope = {
      format: FAKE_VAULT_FORMAT,
      vaultId: this.nextId("vault"),
      password: seed.masterPassword,
      revision: seed.revision ?? 1,
      entries: (seed.entries ?? []).map((entry) => this.makeEntry(entry)),
      settings,
    };
    this.files.set(path, JSON.stringify(envelope, null, 2));
    return path;
  }

  /** Escribe un fichero arbitrario en el sistema de ficheros en memoria. */
  seedFile(path: string, contents: string): void {
    this.files.set(path, contents);
  }

  /** Ruta que devolverá `open()` del diálogo (null = el usuario cancela). */
  setOpenDialogResult(path: string | null): void {
    this.openDialogResult = path;
  }

  /** Ruta que devolverá `save()` del diálogo (null = el usuario cancela). */
  setSaveDialogResult(path: string | null): void {
    this.saveDialogResult = path;
  }

  /** Estado observable para asserts. */
  snapshot(): FakeSnapshot {
    const session = this.session;
    return {
      unlocked: session !== null,
      vaultId: session?.vaultId ?? null,
      revision: session?.revision ?? null,
      entries: session ? clone(session.entries) : [],
      visibleEntries: session ? this.visible(session) : [],
      icon: session ? iconOf(session.settings) : null,
      preferences: clone(this.preferences),
      files: Object.fromEntries(this.files),
      dirs: Array.from(this.dirs),
      openedUrls: [...this.openedUrls],
    };
  }

  /** Contenido de un fichero del sistema en memoria, o undefined si no existe. */
  fileText(path: string): string | undefined {
    return this.files.get(path);
  }

  // ---------------------------------------------------------------------------
  // Enrutador de invoke (lo llama installFakeIpc para cada IPC)
  // ---------------------------------------------------------------------------

  async invoke(cmd: string, args: unknown = {}, options?: FakeInvokeOptions): Promise<unknown> {
    this.calls.push({ cmd, args });
    const a = (args ?? {}) as Record<string, unknown>;

    switch (cmd) {
      // preferences.rs
      case "get_preferences":
        return clone(this.preferences);
      case "save_preferences":
        this.preferences = clone(a.preferences as Preferences);
        return clone(this.preferences);

      // vault.rs
      case "create_vault":
        return this.createVault(a.masterPassword as string);
      case "unlock_vault":
        return this.unlockVault(a.contents as string, a.masterPassword as string);
      case "lock_vault":
        this.session = null;
        return null;
      case "list_entries":
        return this.visible(this.requireSession());
      case "upsert_entry":
        return this.upsertEntry(a.entry as VaultEntry);
      case "delete_entry":
        return this.deleteEntry(a.id as string);
      case "change_master_password":
        return this.changeMasterPassword(a.oldPassword as string, a.newPassword as string);
      case "save_vault":
        return this.saveVault();
      case "export_vault_copy":
        return this.serialize(this.requireSession());
      case "export_legacy_xml":
        return entriesToLegacyXml(this.visible(this.requireSession()), FAKE_APP_VERSION);
      case "verify_export":
        return verifyExport(a.kind as ExportKind, a.contents as string);
      case "export_save_android":
        return exportSaveAndroid(a.kind as ExportKind, a.contents as string);
      case "set_vault_icon":
        return this.setVaultIcon(a.icon as string);
      case "get_sync_config":
        return readSyncConfig(this.requireSession().settings);
      case "set_sync_config":
        return this.setSyncConfig(a.config as SyncConfig);
      case "test_sync":
        throw this.ftpUnavailableError(normalizeSync(a.config as Partial<SyncConfig>));
      case "download_ftp_vault":
        throw this.ftpUnavailableError(normalizeSync(a.config as Partial<SyncConfig>));
      case "sync_check":
        return this.syncCheck();
      case "sync_now":
        return this.syncNow();
      case "generate_password":
        return generatePassword(a.options as GeneratePasswordOptions);
      case "is_android":
        return false;
      case "import_legacy_preview":
        return this.importLegacyPreview(
          a.name as string,
          a.contents,
          a.legacyPassword as string | null | undefined,
        );
      case "import_legacy_commit":
        return this.importLegacyCommit(a.importId as string);

      // Comandos de plugin que usa App.tsx.
      case "plugin:dialog|open":
        return this.openDialogResult;
      case "plugin:dialog|save":
        return this.saveDialogResult;
      case "plugin:fs|read_text_file":
        return Array.from(new TextEncoder().encode(this.readFileOrThrow(a.path as string)));
      case "plugin:fs|read_file":
        return Array.from(new TextEncoder().encode(this.readFileOrThrow(a.path as string)));
      case "plugin:fs|write_text_file":
        return this.writeTextFile(toBytes(args), options);
      case "plugin:fs|mkdir":
        this.dirs.add(a.path as string);
        return null;
      case "plugin:path|resolve_directory":
        if (a.directory === BaseDirectory.AppLocalData) return FAKE_APP_LOCAL_DATA;
        throw new Error(`FakeBackend: directorio no implementado: ${String(a.directory)}`);
      case "plugin:path|join":
        return (a.paths as string[]).join("/").replace(/\/+/g, "/");
      case "plugin:opener|open_url":
        this.openedUrls.push(a.url as string);
        return null;

      // Comandos de ventana y de eventos que usa TitleBar (ver installFakeIpc: mockWindows).
      case "plugin:window|is_maximized":
        return this.windowMaximized;
      case "plugin:window|toggle_maximize":
        this.windowMaximized = !this.windowMaximized;
        return null;
      case "plugin:window|minimize":
      case "plugin:window|close":
        return null;
      case "plugin:event|listen":
        // mockIPC guarda el handler; el fake solo devuelve un id de evento.
        return this.nextNumericId();
      case "plugin:event|unlisten":
        return null;

      default:
        throw new Error(`FakeBackend: comando no implementado: ${cmd}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Comandos de vault.rs
  // ---------------------------------------------------------------------------

  private createVault(masterPassword: string): VaultSnapshot {
    assertPasswordLength(masterPassword);
    const session: Session = {
      vaultId: this.nextId("vault"),
      password: masterPassword,
      revision: 0,
      entries: [],
      settings: {},
    };
    const contents = this.seal(session);
    this.session = session;
    return { status: this.status(session), contents };
  }

  private unlockVault(contents: string, masterPassword: string): VaultStatus {
    const envelope = this.parseEnvelope(contents);
    if (envelope.password !== masterPassword) throw "master_password_incorrect";
    const session: Session = {
      vaultId: envelope.vaultId,
      password: envelope.password,
      revision: envelope.revision,
      entries: clone(envelope.entries),
      settings: clone(envelope.settings),
    };
    this.session = session;
    return this.status(session);
  }

  private upsertEntry(entry: VaultEntry): EntriesSnapshot {
    const session = this.requireSession();
    const now = this.now();
    const title = entry.title.trim();
    if (!title) throw "entry_title_required";

    // Como Rust: id vacío = alta con id nuevo; si no, conserva createdAt salvo que venga vacío.
    const isNew = !(entry.id ?? "").trim();
    const id = isNew ? this.nextId("entry") : entry.id;
    const createdAt = isNew || !entry.createdAt ? now : entry.createdAt;
    const saved: VaultEntry = {
      ...entry,
      id,
      title,
      createdAt,
      updatedAt: now,
      deletedAt: null,
    };

    // Como Rust, la búsqueda incluye tombstones: reusar el id de un borrado lo revive.
    const index = session.entries.findIndex((item) => item.id === id);
    if (index >= 0) {
      session.entries[index] = saved;
    } else {
      session.entries.push(saved);
    }
    const contents = this.seal(session);
    return { entries: this.visible(session), contents };
  }

  private deleteEntry(id: string): EntriesSnapshot {
    const session = this.requireSession();
    const now = this.now();
    // Borrado lógico (tombstone): la entrada se queda en el fichero con deletedAt.
    const entry = session.entries.find((item) => item.id === id);
    if (entry) {
      entry.deletedAt = now;
      entry.updatedAt = now;
    }
    // Como Rust, cualquier borrado sella el vault aunque el id no exista.
    const contents = this.seal(session);
    return { entries: this.visible(session), contents };
  }

  private changeMasterPassword(oldPassword: string, newPassword: string): VaultSnapshot {
    // Rust valida la nueva clave antes de mirar si hay sesión.
    assertPasswordLength(newPassword);
    const session = this.requireSession();
    if (session.password !== oldPassword) throw "master_password_incorrect";
    session.password = newPassword;
    const contents = this.seal(session);
    return { status: this.status(session), contents };
  }

  private saveVault(): VaultSnapshot {
    const session = this.requireSession();
    // save_vault no sube la revisión.
    return { status: this.status(session), contents: this.serialize(session) };
  }

  private setVaultIcon(icon: string): VaultSnapshot {
    const session = this.requireSession();
    session.settings.icon = icon;
    const contents = this.seal(session);
    return { status: this.status(session), contents };
  }

  private setSyncConfig(config: SyncConfig): VaultSnapshot {
    const session = this.requireSession();
    session.settings.sync = normalizeSync(config);
    const contents = this.seal(session);
    return { status: this.status(session), contents };
  }

  // ---------------------------------------------------------------------------
  // Sync y FTP: no hay servidor en el fake. Las validaciones son las de sync.rs;
  // cuando la configuración pasaría a conectar, falla con sync_connect_failed.
  // ---------------------------------------------------------------------------

  private ftpUnavailableError(config: SyncConfig): string {
    if (!config.host.trim()) return "sync_host_required";
    const protocol = config.protocol.trim().toLowerCase();
    if (protocol !== "" && protocol !== "ftp" && protocol !== "ftps") {
      return "sync_protocol_invalid";
    }
    return "sync_connect_failed";
  }

  private syncCheck(): SyncCheck {
    const session = this.requireSession();
    const config = readSyncConfig(session.settings);
    if (!config || !config.enabled) {
      return { configured: false, remoteRevision: null, localRevision: session.revision };
    }
    throw this.ftpUnavailableError(config);
  }

  private syncNow(): never {
    const session = this.requireSession();
    const config = readSyncConfig(session.settings);
    if (!config) throw "sync_not_configured";
    if (!config.enabled) throw "sync_disabled";
    throw this.ftpUnavailableError(config);
  }

  // ---------------------------------------------------------------------------
  // Import / export legacy
  // ---------------------------------------------------------------------------

  private importLegacyPreview(
    name: string,
    contents: unknown,
    legacyPassword: string | null | undefined,
  ): ImportPreview {
    const entries = parseLegacyBytes(name, toBytes(contents), legacyPassword || undefined);
    const importId = this.nextId("import");
    this.pendingImports.set(importId, entries);
    return {
      importId,
      count: entries.length,
      entries: entries.slice(0, LEGACY_PREVIEW_LIMIT).map((entry) => ({
        title: entry.title,
        username: entry.username,
        url: entry.url,
        hasPassword: entry.password !== "",
      })),
    };
  }

  private importLegacyCommit(importId: string): EntriesSnapshot {
    const pending = this.pendingImports.get(importId);
    if (!pending) throw "import_not_found";
    // Como Rust: la importación pendiente se consume antes de mirar la sesión.
    this.pendingImports.delete(importId);
    const session = this.requireSession();
    const now = this.now();
    for (const entry of pending) {
      entry.id = this.nextId("entry");
      entry.createdAt = now;
      entry.updatedAt = now;
      entry.deletedAt = null;
      entry.conflict = false;
      session.entries.push(entry);
    }
    const contents = this.seal(session);
    return { entries: this.visible(session), contents };
  }

  // ---------------------------------------------------------------------------
  // Plugin fs / dialog
  // ---------------------------------------------------------------------------

  private readFileOrThrow(path: string): string {
    const contents = this.files.get(path);
    if (contents === undefined) throw "No such file or directory (os error 2)";
    return contents;
  }

  private writeTextFile(bytes: Uint8Array, options: FakeInvokeOptions | undefined): null {
    const encodedPath = options?.headers?.path;
    if (!encodedPath) throw new Error("FakeBackend: write_text_file sin ruta en headers");
    // tauri-plugin-fs / plugin-fs: la ruta va URL-encoded en headers.path.
    const path = decodeURIComponent(encodedPath);
    this.files.set(path, new TextDecoder().decode(bytes));
    return null;
  }

  // ---------------------------------------------------------------------------
  // Helpers de estado
  // ---------------------------------------------------------------------------

  private requireSession(): Session {
    if (!this.session) throw "vault_locked";
    return this.session;
  }

  private parseEnvelope(contents: string): Envelope {
    let parsed: unknown;
    try {
      parsed = JSON.parse(contents);
    } catch {
      throw "vault_file_invalid";
    }
    if (!parsed || typeof parsed !== "object") throw "vault_file_invalid";
    const envelope = parsed as Envelope;
    if (envelope.format !== FAKE_VAULT_FORMAT) throw "unsupported_vault_format";
    return envelope;
  }

  private serialize(session: Session): string {
    const envelope: Envelope = {
      format: FAKE_VAULT_FORMAT,
      vaultId: session.vaultId,
      password: session.password,
      revision: session.revision,
      entries: session.entries,
      settings: session.settings,
    };
    return JSON.stringify(envelope, null, 2);
  }

  /** Como seal_envelope de Rust: sube la revisión y devuelve el fichero. */
  private seal(session: Session): string {
    session.revision += 1;
    return this.serialize(session);
  }

  private status(session: Session): VaultStatus {
    return {
      vaultId: session.vaultId,
      revision: session.revision,
      entryCount: this.visible(session).length,
      icon: iconOf(session.settings),
    };
  }

  private visible(session: Session): VaultEntry[] {
    return session.entries
      .filter((entry) => !entry.deletedAt)
      .map((entry) => clone(entry))
      .sort(compareByTitleThenUser);
  }

  private makeEntry(seed: FakeEntrySeed): VaultEntry {
    const now = this.now();
    return {
      id: seed.id ?? this.nextId("entry"),
      title: seed.title,
      username: seed.username ?? "",
      password: seed.password ?? "",
      url: seed.url ?? "",
      notes: seed.notes ?? "",
      createdAt: now,
      updatedAt: now,
      deletedAt: seed.deletedAt ?? null,
      conflict: false,
    };
  }

  private nextId(prefix: string): string {
    this.counter += 1;
    return `fake-${prefix}-${this.counter}`;
  }

  private nextNumericId(): number {
    this.counter += 1;
    return this.counter;
  }
}
