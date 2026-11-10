import { BaseDirectory } from "@tauri-apps/api/path";
import { describe, expect, it } from "vitest";
import { FakeBackend, generatePassword } from "./fakeBackend";

const MASTER = "clave-maestra-123";

// Reloj determinista: cada llamada devuelve un instante posterior al anterior.
function steppingClock() {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString();
}

function newBackend(entries?: { title: string; username?: string; deletedAt?: string | null }[]) {
  const backend = new FakeBackend({ now: steppingClock() });
  backend.seedVault({ masterPassword: MASTER, entries });
  return backend;
}

async function unlock(backend: FakeBackend, password = MASTER) {
  const contents = backend.fileText("/vaults/passdroid.pdvault");
  if (contents === undefined) throw new Error("el fichero sembrado no existe");
  return backend.invoke("unlock_vault", { contents, masterPassword: password }) as Promise<{
    revision: number;
    entryCount: number;
    vaultId: string;
    icon: string;
  }>;
}

function entryPayload(overrides: Record<string, unknown> = {}) {
  return {
    id: "",
    title: "Mail",
    username: "user@example.com",
    password: "secret",
    url: "",
    notes: "",
    createdAt: "",
    updatedAt: "",
    deletedAt: null,
    conflict: false,
    ...overrides,
  };
}

describe("FakeBackend: desbloqueo", () => {
  it("desbloquea con la contraseña correcta y devuelve el estado del vault", async () => {
    const backend = newBackend([{ title: "GitHub" }]);
    const status = await unlock(backend);

    expect(status.entryCount).toBe(1);
    expect(status.revision).toBe(1);
    expect(backend.snapshot().unlocked).toBe(true);
  });

  it("rechaza una contraseña incorrecta con el mismo error que Rust y no abre el vault", async () => {
    const backend = newBackend();

    await expect(unlock(backend, "otra-clave-999")).rejects.toBe("master_password_incorrect");
    expect(backend.snapshot().unlocked).toBe(false);
  });

  it("rechaza un fichero que no es JSON válido", async () => {
    const backend = new FakeBackend();
    backend.seedFile("/x.pdvault", "esto no es un vault");

    await expect(
      backend.invoke("unlock_vault", { contents: "esto no es un vault", masterPassword: MASTER }),
    ).rejects.toBe("vault_file_invalid");
  });
});

describe("FakeBackend: comandos con vault bloqueado", () => {
  it("list, upsert, delete y change_master_password fallan con vault_locked", async () => {
    const backend = newBackend();

    await expect(backend.invoke("list_entries")).rejects.toBe("vault_locked");
    await expect(backend.invoke("upsert_entry", { entry: entryPayload() })).rejects.toBe("vault_locked");
    await expect(backend.invoke("delete_entry", { id: "x" })).rejects.toBe("vault_locked");
    await expect(
      backend.invoke("change_master_password", { oldPassword: MASTER, newPassword: "nueva-clave-1" }),
    ).rejects.toBe("vault_locked");
  });

  it("lock_vault bloquea y el siguiente list_entries falla", async () => {
    const backend = newBackend([{ title: "GitHub" }]);
    await unlock(backend);

    await expect(backend.invoke("lock_vault")).resolves.toBeNull();
    expect(backend.snapshot().unlocked).toBe(false);
    await expect(backend.invoke("list_entries")).rejects.toBe("vault_locked");
  });
});

describe("FakeBackend: entradas, revisión y tombstones", () => {
  it("list_entries devuelve las entradas visibles ordenadas por título y usuario", async () => {
    const backend = newBackend([
      { title: "banco", username: "b" },
      { title: "Banco", username: "a" },
      { title: "Zeta" },
    ]);
    await unlock(backend);

    const titles = (await backend.invoke("list_entries")) as { title: string; username: string }[];
    expect(titles.map((e) => `${e.title}/${e.username}`)).toEqual(["Banco/a", "banco/b", "Zeta/"]);
  });

  it("upsert de alta asigna id, createdAt y updatedAt, recorta el título y sube la revisión", async () => {
    const backend = newBackend();
    await unlock(backend);

    const snap = (await backend.invoke("upsert_entry", {
      entry: entryPayload({ title: "  Mail  " }),
    })) as { entries: { id: string; title: string; createdAt: string; updatedAt: string }[]; contents: string };

    expect(snap.entries).toHaveLength(1);
    const [created] = snap.entries;
    expect(created.title).toBe("Mail");
    expect(created.id).not.toBe("");
    expect(created.createdAt).toBe(created.updatedAt);
    expect(backend.snapshot().revision).toBe(2);
    // El fichero devuelto es el que la app persiste: lleva la revisión nueva.
    expect(JSON.parse(snap.contents).revision).toBe(2);
  });

  it("upsert de edición conserva id y createdAt y actualiza updatedAt", async () => {
    const backend = newBackend([{ title: "GitHub" }]);
    await unlock(backend);
    const [original] = backend.snapshot().entries;

    await backend.invoke("upsert_entry", {
      entry: { ...original, title: "GitHub Work" },
    });

    const after = backend.snapshot();
    expect(after.entries).toHaveLength(1);
    expect(after.entries[0].id).toBe(original.id);
    expect(after.entries[0].title).toBe("GitHub Work");
    expect(after.entries[0].createdAt).toBe(original.createdAt);
    expect(after.entries[0].updatedAt > original.updatedAt).toBe(true);
    expect(after.revision).toBe(2);
  });

  it("upsert con título vacío devuelve entry_title_required y no cambia nada", async () => {
    const backend = newBackend();
    await unlock(backend);

    await expect(
      backend.invoke("upsert_entry", { entry: entryPayload({ title: "   " }) }),
    ).rejects.toBe("entry_title_required");
    expect(backend.snapshot().entries).toHaveLength(0);
    expect(backend.snapshot().revision).toBe(1);
  });

  it("delete_entry deja un tombstone: sale de la lista pero queda en el fichero, y sube la revisión", async () => {
    const backend = newBackend([{ title: "GitHub" }, { title: "Banco" }]);
    await unlock(backend);
    const github = backend.snapshot().visibleEntries.find((e) => e.title === "GitHub");
    if (!github) throw new Error("GitHub no está en la lista");

    const snap = (await backend.invoke("delete_entry", { id: github.id })) as {
      entries: { title: string }[];
    };

    expect(snap.entries.map((e) => e.title)).toEqual(["Banco"]);
    const state = backend.snapshot();
    const tombstone = state.entries.find((e) => e.id === github.id);
    expect(tombstone?.deletedAt).toEqual(expect.any(String));
    expect(state.revision).toBe(2);
    expect(state.visibleEntries.map((e) => e.title)).toEqual(["Banco"]);
  });

  it("delete_entry con un id desconocido no falla, pero sí sella el vault", async () => {
    const backend = newBackend([{ title: "GitHub" }]);
    await unlock(backend);

    await backend.invoke("delete_entry", { id: "no-existe" });
    expect(backend.snapshot().revision).toBe(2);
    expect(backend.snapshot().visibleEntries).toHaveLength(1);
  });

  it("save_vault y export_vault_copy no suben la revisión", async () => {
    const backend = newBackend([{ title: "GitHub" }]);
    await unlock(backend);

    await backend.invoke("save_vault");
    await backend.invoke("export_vault_copy");
    expect(backend.snapshot().revision).toBe(1);
  });
});

describe("FakeBackend: contraseña maestra", () => {
  it("change_master_password con la clave antigua incorrecta no cambia la clave", async () => {
    const backend = newBackend();
    await unlock(backend);

    await expect(
      backend.invoke("change_master_password", {
        oldPassword: "no-es-esta",
        newPassword: "nueva-clave-456",
      }),
    ).rejects.toBe("master_password_incorrect");

    expect(backend.snapshot().revision).toBe(1);
    await backend.invoke("lock_vault");
    await expect(unlock(backend, MASTER)).resolves.toBeDefined();
  });

  it("change_master_password reescribe el vault: la clave nueva abre y la antigua no", async () => {
    const backend = newBackend([{ title: "GitHub" }]);
    await unlock(backend);

    const changed = (await backend.invoke("change_master_password", {
      oldPassword: MASTER,
      newPassword: "nueva-clave-456",
    })) as { contents: string };

    await backend.invoke("lock_vault");
    await expect(
      backend.invoke("unlock_vault", { contents: changed.contents, masterPassword: MASTER }),
    ).rejects.toBe("master_password_incorrect");
    await expect(
      backend.invoke("unlock_vault", { contents: changed.contents, masterPassword: "nueva-clave-456" }),
    ).resolves.toMatchObject({ entryCount: 1 });
  });

  it("create_vault valida la longitud mínima de la clave", async () => {
    const backend = new FakeBackend();
    await expect(backend.invoke("create_vault", { masterPassword: "corta" })).rejects.toBe(
      "master_password_too_short",
    );
  });
});

describe("FakeBackend: icono, sync y preferencias", () => {
  it("set_vault_icon guarda el icono dentro del vault y se ve en el estado", async () => {
    const backend = newBackend();
    await unlock(backend);

    await backend.invoke("set_vault_icon", { icon: "bank" });
    expect(backend.snapshot().icon).toBe("bank");
    expect(backend.snapshot().revision).toBe(2);
  });

  it("sin configurar, get_sync_config devuelve null y sync_now falla con sync_not_configured", async () => {
    const backend = newBackend();
    await unlock(backend);

    await expect(backend.invoke("get_sync_config")).resolves.toBeNull();
    await expect(backend.invoke("sync_now")).rejects.toBe("sync_not_configured");
    await expect(backend.invoke("sync_check")).resolves.toEqual({
      configured: false,
      remoteRevision: null,
      localRevision: 1,
    });
  });

  it("con sync configurado pero deshabilitado, sync_now falla con sync_disabled", async () => {
    const backend = new FakeBackend();
    backend.seedVault({
      masterPassword: MASTER,
      sync: { enabled: false, host: "ftp.example.com" },
    });
    await unlock(backend);

    await expect(backend.invoke("sync_now")).rejects.toBe("sync_disabled");
  });

  it("FTP sin servidor: test_sync valida el host y, con host, devuelve sync_connect_failed", async () => {
    const backend = newBackend();
    await unlock(backend);

    await expect(
      backend.invoke("test_sync", { config: { enabled: true, host: "  " } }),
    ).rejects.toBe("sync_host_required");
    await expect(
      backend.invoke("test_sync", { config: { enabled: true, host: "ftp.example.com", protocol: "sftp" } }),
    ).rejects.toBe("sync_protocol_invalid");
    await expect(
      backend.invoke("test_sync", { config: { enabled: true, host: "ftp.example.com", protocol: "ftps" } }),
    ).rejects.toBe("sync_connect_failed");
  });

  it("get_preferences y save_preferences guardan en memoria", async () => {
    const backend = new FakeBackend({ preferences: { language: "es" } });

    expect(await backend.invoke("get_preferences")).toEqual({
      theme: "system",
      language: "es",
      recentVaults: [],
      vaultIcons: {},
      railCollapsed: false,
      notesView: "edit",
    });
    await backend.invoke("save_preferences", {
      preferences: {
        theme: "dark",
        language: "en",
        recentVaults: ["/a.pdvault"],
        vaultIcons: {},
        railCollapsed: true,
        notesView: "preview",
      },
    });
    expect(backend.snapshot().preferences).toMatchObject({
      theme: "dark",
      recentVaults: ["/a.pdvault"],
      railCollapsed: true,
      notesView: "preview",
    });
  });

  it("is_android devuelve false", async () => {
    await expect(new FakeBackend().invoke("is_android")).resolves.toBe(false);
  });
});

describe("FakeBackend: generador de contraseñas", () => {
  it("respeta la longitud y solo usa los grupos activos", () => {
    const digits = generatePassword({
      length: 20,
      uppercase: false,
      lowercase: false,
      numbers: true,
      symbols: false,
    });
    expect(digits).toMatch(/^[23456789]{20}$/);
  });

  it("recorta la longitud al rango 8..256", () => {
    const short = generatePassword({ length: 1, uppercase: true, lowercase: false, numbers: false, symbols: false });
    const long = generatePassword({ length: 9999, uppercase: true, lowercase: false, numbers: false, symbols: false });
    expect(short).toHaveLength(8);
    expect(long).toHaveLength(256);
  });

  it("sin ningún grupo activo falla con password_generator_empty_charset", async () => {
    const backend = new FakeBackend();
    await expect(
      backend.invoke("generate_password", {
        options: { length: 16, uppercase: false, lowercase: false, numbers: false, symbols: false },
      }),
    ).rejects.toBe("password_generator_empty_charset");
  });
});

describe("FakeBackend: importación y exportación legacy", () => {
  const legacyXml = `<?xml version="1.0" encoding="UTF-8"?>
<passdroid version="2.0">
  <system name="Banco">
    <username><![CDATA[alex]]></username>
    <password><![CDATA[p@ss]]></password>
    <url><![CDATA[https://banco.example]]></url>
  </system>
  <system name="Foro"><username><![CDATA[nick]]></username></system>
</passdroid>`;

  it("importa XML en claro: preview, luego commit añade las entradas", async () => {
    const backend = newBackend([{ title: "GitHub" }]);
    await unlock(backend);

    const bytes = Array.from(new TextEncoder().encode(legacyXml));
    const preview = (await backend.invoke("import_legacy_preview", {
      name: "export.xml",
      contents: bytes,
      legacyPassword: null,
    })) as { importId: string; count: number; entries: { title: string; hasPassword: boolean }[] };

    expect(preview.count).toBe(2);
    expect(preview.entries.map((e) => [e.title, e.hasPassword])).toEqual([
      ["Banco", true],
      ["Foro", false],
    ]);

    const committed = (await backend.invoke("import_legacy_commit", {
      importId: preview.importId,
    })) as { entries: { title: string }[] };
    expect(committed.entries.map((e) => e.title)).toEqual(["Banco", "Foro", "GitHub"]);

    // Una importación solo se puede confirmar una vez.
    await expect(
      backend.invoke("import_legacy_commit", { importId: preview.importId }),
    ).rejects.toBe("import_not_found");
  });

  it("export_legacy_xml produce XML en claro con las entradas visibles", async () => {
    const backend = newBackend([{ title: "Banco" }]);
    await unlock(backend);

    const xml = (await backend.invoke("export_legacy_xml")) as string;
    expect(xml).toContain('<system name="Banco">');
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
  });
});

describe("FakeBackend: IPC de plugins", () => {
  it("write_text_file toma la ruta de options.headers y read_text_file la devuelve", async () => {
    const backend = new FakeBackend();
    const body = new TextEncoder().encode("contenido");

    await backend.invoke("plugin:fs|write_text_file", body, {
      headers: { path: encodeURIComponent("/vaults/nuevo.pdvault"), options: "undefined" },
    });

    expect(backend.fileText("/vaults/nuevo.pdvault")).toBe("contenido");
    const bytes = (await backend.invoke("plugin:fs|read_text_file", {
      path: "/vaults/nuevo.pdvault",
    })) as number[];
    expect(new TextDecoder().decode(Uint8Array.from(bytes))).toBe("contenido");
  });

  it("read_text_file de un fichero inexistente falla", async () => {
    await expect(
      new FakeBackend().invoke("plugin:fs|read_text_file", { path: "/no/existe" }),
    ).rejects.toBe("No such file or directory (os error 2)");
  });

  it("path join y appLocalDataDir usan el directorio falso", async () => {
    const backend = new FakeBackend();
    const base = (await backend.invoke("plugin:path|resolve_directory", { directory: BaseDirectory.AppLocalData })) as string;
    expect(base).toBe("/fake/app-local-data");
    expect(await backend.invoke("plugin:path|join", { paths: [base, "vaults", "a.pdvault"] })).toBe(
      "/fake/app-local-data/vaults/a.pdvault",
    );
  });

  it("dialog y opener: los diálogos devuelven lo configurado y las URLs abiertas quedan registradas", async () => {
    const backend = new FakeBackend();
    backend.setOpenDialogResult("/vaults/passdroid.pdvault");
    backend.setSaveDialogResult(null);

    await expect(backend.invoke("plugin:dialog|open", { options: {} })).resolves.toBe(
      "/vaults/passdroid.pdvault",
    );
    await expect(backend.invoke("plugin:dialog|save", { options: {} })).resolves.toBeNull();
    await backend.invoke("plugin:opener|open_url", { url: "https://github.com", with: undefined });
    expect(backend.snapshot().openedUrls).toEqual(["https://github.com"]);
  });
});

describe("FakeBackend: verificación y guardado de exportaciones", () => {
  const XML = '<?xml version="1.0" encoding="UTF-8"?>\n<passdroid version="1">\n</passdroid>\n';

  it("verify_export acepta un vault exportado y un XML con la raíz passdroid", async () => {
    const backend = newBackend([{ title: "GitHub" }]);
    const vault = backend.fileText("/vaults/passdroid.pdvault") ?? "";

    await expect(backend.invoke("verify_export", { kind: "vault", contents: vault })).resolves.toBeNull();
    await expect(backend.invoke("verify_export", { kind: "xml", contents: XML })).resolves.toBeNull();
  });

  it("verify_export rechaza contenido vacío, basura, otro formato o una raíz XML ajena", async () => {
    const backend = new FakeBackend();

    await expect(backend.invoke("verify_export", { kind: "vault", contents: "  \n" })).rejects.toBe(
      "export_verify_failed",
    );
    await expect(backend.invoke("verify_export", { kind: "vault", contents: "no es json" })).rejects.toBe(
      "export_verify_failed",
    );
    await expect(
      backend.invoke("verify_export", { kind: "vault", contents: '{"format":"otro"}' }),
    ).rejects.toBe("export_verify_failed");
    await expect(backend.invoke("verify_export", { kind: "xml", contents: "" })).rejects.toBe(
      "export_verify_failed",
    );
    await expect(backend.invoke("verify_export", { kind: "xml", contents: "<otro/>" })).rejects.toBe(
      "export_verify_failed",
    );
    await expect(backend.invoke("verify_export", { kind: "xml", contents: "<passdroid>" })).rejects.toBe(
      "export_verify_failed",
    );
  });

  it("export_save_android verifica primero y en escritorio falla con export_unsupported", async () => {
    const backend = new FakeBackend();

    // Contenido malo: falla por la verificación, igual que en Rust.
    await expect(
      backend.invoke("export_save_android", { kind: "xml", contents: "<otro/>" }),
    ).rejects.toBe("export_verify_failed");
    // Contenido bueno: en escritorio no hay guardado sin selector.
    await expect(backend.invoke("export_save_android", { kind: "xml", contents: XML })).rejects.toBe(
      "export_unsupported",
    );
  });
});

describe("FakeBackend: ventana y eventos (TitleBar)", () => {
  it("maximizar alterna el estado y is_maximized lo refleja", async () => {
    const backend = new FakeBackend();

    await expect(backend.invoke("plugin:window|is_maximized")).resolves.toBe(false);
    await backend.invoke("plugin:window|toggle_maximize");
    await expect(backend.invoke("plugin:window|is_maximized")).resolves.toBe(true);
    await backend.invoke("plugin:window|toggle_maximize");
    await expect(backend.invoke("plugin:window|is_maximized")).resolves.toBe(false);
  });

  it("minimize y close se aceptan sin efectos observables en el estado", async () => {
    const backend = new FakeBackend();

    await expect(backend.invoke("plugin:window|minimize")).resolves.toBeNull();
    await expect(backend.invoke("plugin:window|close")).resolves.toBeNull();
    expect(backend.snapshot().unlocked).toBe(false);
  });

  it("listen devuelve un id numérico y unlisten se acepta", async () => {
    const backend = new FakeBackend();

    const first = await backend.invoke("plugin:event|listen", { event: "tauri://resize" });
    const second = await backend.invoke("plugin:event|listen", { event: "tauri://resize" });
    expect(typeof first).toBe("number");
    expect(second).not.toBe(first);
    await expect(backend.invoke("plugin:event|unlisten", { event: "tauri://resize", eventId: first })).resolves.toBeNull();
  });
});

describe("FakeBackend: comandos no implementados", () => {
  it("un comando sin implementar lanza un error que nombra el comando", async () => {
    await expect(new FakeBackend().invoke("comando_inventado")).rejects.toThrow(
      "comando no implementado: comando_inventado",
    );
  });
});
