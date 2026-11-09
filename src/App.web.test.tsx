import { StrictMode } from "react";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import App from "./App";
import { LanguageProvider } from "./context/LanguageContext";
import { ThemeProvider } from "./context/ThemeContext";
import { WEB_CAPABILITIES } from "./platform";
import { FakeBackend } from "./testing/fakeBackend";
import { installFakeIpc, uninstallFakeIpc } from "./testing/installFakeIpc";

// Mismo árbol de providers que src/main.tsx.
function renderApp() {
  return render(
    <StrictMode>
      <LanguageProvider>
        <ThemeProvider>
          <App />
        </ThemeProvider>
      </LanguageProvider>
    </StrictMode>,
  );
}

// Ruta que el backend web usa para el único vault del servidor.
const WEB_VAULT = "server://vault";
// Vault de escritorio, para la prueba de regresión.
const DESKTOP_VAULT = "/vaults/passdroid.pdvault";
const MASTER = "clave-maestra-123";

let backend: FakeBackend;

beforeEach(() => {
  backend = new FakeBackend({
    preferences: { language: "es", recentVaults: [WEB_VAULT] },
  });
  backend.seedVault({
    path: WEB_VAULT,
    masterPassword: MASTER,
    entries: [
      { title: "GitHub", username: "alexwing", password: "gh-secret", url: "https://github.com" },
      { title: "Banco", username: "alex", password: "bank-secret" },
    ],
  });
  installFakeIpc(backend);
});

afterEach(() => {
  cleanup();
  uninstallFakeIpc();
});

// Escritorio por defecto: el test de web activa las capacidades web antes de renderizar.
describe("Passdroid Web: UI compartida con capacidades web", () => {
  beforeEach(() => {
    globalThis.__PASSDROID_PLATFORM__ = WEB_CAPABILITIES;
  });

  afterEach(() => {
    globalThis.__PASSDROID_PLATFORM__ = undefined;
  });

  // Inicio -> reciente del servidor -> desbloqueo.
  async function unlockFromRecent(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByRole("button", { name: /server\/vault/ }));
    await user.type(await screen.findByLabelText("Clave maestra"), MASTER);
    await user.click(screen.getByRole("button", { name: "Desbloquear" }));
    await screen.findByRole("button", { name: /GitHub/ });
  }

  // Abre Ajustes desde el rail (hay dos botones con ese nombre: rail y barra móvil).
  async function openSettings(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getAllByRole("button", { name: "Ajustes" })[0]);
  }

  it("la pantalla de inicio solo ofrece el vault reciente, sin abrir, crear ni vincular", async () => {
    renderApp();

    expect(await screen.findByRole("button", { name: /server\/vault/ })).toBeInTheDocument();
    expect(screen.getByText("vault", { selector: ".recent-name" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Abrir fichero" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Nuevo vault" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Vincular por QR" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Quitar de la lista" })).not.toBeInTheDocument();
  });

  it("desbloquea desde el reciente y muestra las entradas", async () => {
    const user = userEvent.setup();
    renderApp();

    await unlockFromRecent(user);

    expect(screen.getByRole("button", { name: /Banco/ })).toBeInTheDocument();
    expect(screen.getByText("2 entradas")).toBeInTheDocument();
    expect(backend.snapshot().unlocked).toBe(true);
  });

  it("sin botones de sincronizar, importar, exportar, pestañas de sync y seguridad, ni cambio de icono; el estado dice que está en el servidor", async () => {
    const user = userEvent.setup();
    renderApp();
    await unlockFromRecent(user);

    expect(screen.queryByRole("button", { name: /Sincroniz/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Importar" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Exportar" })).not.toBeInTheDocument();
    expect(screen.getAllByText("Guardado en el servidor").length).toBeGreaterThan(0);
    expect(screen.queryByText("Solo en este dispositivo")).not.toBeInTheDocument();

    await openSettings(user);
    expect(screen.getByRole("tab", { name: "General" })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: /Sincronización/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Seguridad" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Elegir icono" })).not.toBeInTheDocument();
  });

  it("tras desbloquear no pide la configuración ni el estado de sincronización FTP", async () => {
    const user = userEvent.setup();
    renderApp();
    await unlockFromRecent(user);

    const cmds = backend.calls.map((call) => call.cmd);
    expect(cmds).not.toContain("get_sync_config");
    expect(cmds).not.toContain("sync_check");
  });

  it("un cambio externo del vault recarga la lista y conserva la selección", async () => {
    const user = userEvent.setup();
    renderApp();
    await unlockFromRecent(user);

    // Abre GitHub para comprobar que la selección sobrevive a la recarga.
    await user.click(screen.getByRole("button", { name: /GitHub/ }));
    expect(await screen.findByLabelText("Título", { selector: "input" })).toHaveValue("GitHub");

    // Otro dispositivo escribe en el servidor: el backend cambia por detrás.
    await backend.invoke("upsert_entry", {
      entry: {
        id: "",
        title: "Wifi",
        username: "casa",
        password: "wifi-secret",
        url: "",
        notes: "",
        createdAt: "",
        updatedAt: "",
        deletedAt: null,
        conflict: false,
      },
    });
    act(() => {
      window.dispatchEvent(new Event("passdroid:vault-changed"));
    });

    expect(await screen.findByRole("button", { name: /Wifi/ })).toBeInTheDocument();
    expect(screen.getByText("3 entradas")).toBeInTheDocument();
    expect(screen.getByLabelText("Título", { selector: "input" })).toHaveValue("GitHub");
  });

  it("pagehide bloquea el vault: vuelve al desbloqueo y llama a lock_vault", async () => {
    const user = userEvent.setup();
    renderApp();
    await unlockFromRecent(user);

    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });

    expect(await screen.findByLabelText("Clave maestra")).toBeInTheDocument();
    expect(backend.calls.some((call) => call.cmd === "lock_vault")).toBe(true);
    expect(backend.snapshot().unlocked).toBe(false);
  });

  it("el evento passdroid:lock bloquea el vault igual que pagehide", async () => {
    const user = userEvent.setup();
    renderApp();
    await unlockFromRecent(user);

    act(() => {
      window.dispatchEvent(new Event("passdroid:lock"));
    });

    expect(await screen.findByLabelText("Clave maestra")).toBeInTheDocument();
    expect(backend.calls.some((call) => call.cmd === "lock_vault")).toBe(true);
    expect(backend.snapshot().unlocked).toBe(false);
  });

  it("un error web_conflict_retry_exhausted al guardar muestra su mensaje traducido", async () => {
    const user = userEvent.setup();
    renderApp();
    await unlockFromRecent(user);

    // El fake rechaza el guardado como lo haría el backend web tras agotar los reintentos.
    const original = backend.invoke.bind(backend);
    backend.invoke = async (cmd, args, options) => {
      if (cmd === "upsert_entry") throw "web_conflict_retry_exhausted";
      return original(cmd, args, options);
    };

    await user.click(screen.getByRole("button", { name: "Nueva" }));
    await user.type(screen.getByLabelText("Título", { selector: "input" }), "Gmail");
    await user.click(screen.getByRole("button", { name: "Guardar" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "Otro dispositivo guardó cambios a la vez y no se pudieron fusionar. Inténtalo de nuevo.",
    );
    expect(screen.getByText("2 entradas")).toBeInTheDocument();
  });
});

describe("Escritorio: sin capacidades web la UI conserva sus opciones", () => {
  it("muestra Abrir fichero, Vincular por QR y, dentro de Ajustes, Sincronización y Seguridad", async () => {
    const user = userEvent.setup();
    backend.seedVault({
      path: DESKTOP_VAULT,
      masterPassword: MASTER,
      entries: [{ title: "Correo", username: "alex" }],
    });
    renderApp();

    expect(await screen.findByRole("button", { name: "Abrir fichero" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Vincular por QR" })).toBeInTheDocument();

    backend.setOpenDialogResult(DESKTOP_VAULT);
    await user.click(screen.getByRole("button", { name: "Abrir fichero" }));
    await user.type(await screen.findByLabelText("Clave maestra"), MASTER);
    await user.click(screen.getByRole("button", { name: "Desbloquear" }));
    await screen.findByRole("button", { name: /Correo/ });

    await user.click(screen.getAllByRole("button", { name: "Ajustes" })[0]);
    const tabs = within(screen.getByRole("tablist"));
    expect(tabs.getByRole("tab", { name: /Sincronización/ })).toBeInTheDocument();
    expect(tabs.getByRole("tab", { name: "Seguridad" })).toBeInTheDocument();
  });
});
