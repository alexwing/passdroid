// Browser-only stand-in for `@tauri-apps/api/core` (see vite.preview.config.ts).
// Every value here is obviously fake; nothing is encrypted or persisted.
import type {
  EntriesSnapshot,
  Preferences,
  SyncConfig,
  VaultEntry,
  VaultSnapshot,
  VaultStatus,
} from "../api";

const params = new URLSearchParams(window.location.search);
const android = params.get("android") === "1";

const stamp = (daysAgo: number) => new Date(Date.UTC(2026, 10, 9 - daysAgo, 9, 30)).toISOString();

const demo = (n: number, title: string, username: string, url: string, notes = ""): VaultEntry => ({
  id: `demo-${n}`,
  title,
  username,
  password: `mock-password-${String(n).padStart(2, "0")}`,
  url,
  notes,
  createdAt: stamp(60 + n),
  updatedAt: stamp(n),
  deletedAt: null,
  conflict: false,
});

let entries: VaultEntry[] = [
  demo(1, "Example Mail", "demo.user@example.test", "https://mail.example.test", "Fake entry for previews."),
  demo(2, "Demo Bank", "demo-user-001", "https://bank.example.test", "Not a real account."),
  demo(3, "Sample Cloud", "demo.user@example.test", "https://cloud.example.test"),
  demo(4, "Test Shop", "shopper.demo", "https://shop.example.test", "Fake card ending 0000."),
  demo(5, "Fake Social", "@demo_user", "https://social.example.test"),
  demo(6, "Placeholder VPN", "vpn-demo", "https://vpn.example.test", "Mock license key: XXXX-XXXX-XXXX."),
  demo(7, "Mock Code Hosting", "demo-dev", "https://code.example.test"),
  demo(8, "Imaginary Streaming", "family.demo@example.test", "https://stream.example.test", "Profile PIN is fake."),
];

let revision = 1;
let icon = "";

const status = (): VaultStatus => ({ vaultId: "demo-vault", revision, entryCount: entries.length, icon });
const snapshot = (): VaultSnapshot => ({ status: status(), contents: `MOCK-VAULT-REV-${revision}` });
const entriesSnapshot = (): EntriesSnapshot => ({ entries: [...entries], contents: `MOCK-VAULT-REV-${revision}` });

let preferences: Preferences = {
  theme: "system",
  language: "system",
  recentVaults: ["/mock/vaults/Demo.pdvault"],
  vaultIcons: {},
  railCollapsed: false,
  notesView: "edit",
};

let syncConfig: SyncConfig | null = {
  enabled: true,
  protocol: "ftps",
  host: "ftp.example.test",
  port: 21,
  username: "demo-user",
  password: "mock-sync-password",
  remoteDir: "/passdroid",
  remoteFile: "Demo.pdvault",
};

const fakePassword = (len: number) => {
  const chars = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!#$%";
  return Array.from({ length: len }, (_, i) => chars[(i * 7 + 3) % chars.length]).join("");
};

type Args = Record<string, unknown> | undefined;

const handlers: Record<string, (args: Args) => unknown> = {
  get_preferences: () => preferences,
  save_preferences: (a) => (preferences = a!.preferences as Preferences),
  is_android: () => android,
  create_vault: () => {
    entries = [];
    revision = 1;
    return snapshot();
  },
  unlock_vault: () => status(),
  lock_vault: () => null,
  list_entries: () => [...entries],
  upsert_entry: (a) => {
    const entry = a!.entry as VaultEntry;
    const at = entries.findIndex((e) => e.id === entry.id);
    if (at >= 0) entries[at] = entry;
    else entries = [...entries, entry];
    revision += 1;
    return entriesSnapshot();
  },
  delete_entry: (a) => {
    entries = entries.filter((e) => e.id !== a!.id);
    revision += 1;
    return entriesSnapshot();
  },
  change_master_password: () => snapshot(),
  generate_password: (a) => fakePassword((a!.options as { length: number }).length),
  import_legacy_preview: () => ({
    importId: "mock-import",
    count: 2,
    entries: [
      { title: "Legacy Demo One", username: "legacy.one", url: "https://one.example.test", hasPassword: true },
      { title: "Legacy Demo Two", username: "legacy.two", url: "", hasPassword: false },
    ],
  }),
  import_legacy_commit: () => entriesSnapshot(),
  save_vault: () => snapshot(),
  export_vault_copy: () => "MOCK-VAULT-EXPORT",
  export_legacy_xml: () => "<mock-export/>",
  verify_export: () => null,
  export_save_android: () => ({ name: "Demo-export.pdvault", path: "/storage/emulated/0/Download/Demo-export.pdvault" }),
  set_vault_icon: (a) => {
    icon = a!.icon as string;
    return snapshot();
  },
  get_sync_config: () => syncConfig,
  set_sync_config: (a) => {
    syncConfig = a!.config as SyncConfig;
    return snapshot();
  },
  test_sync: () => null,
  download_ftp_vault: () => "MOCK-VAULT-REV-1",
  sync_check: () => ({ configured: true, remoteRevision: revision, localRevision: revision }),
  sync_now: () => ({ pulled: false, revision, entryCount: entries.length, contents: `MOCK-VAULT-REV-${revision}` }),
};

export async function invoke<T>(cmd: string, args?: Args): Promise<T> {
  const handler = handlers[cmd];
  if (!handler) throw `mock: unknown command ${cmd}`;
  return structuredClone(handler(args)) as T;
}
