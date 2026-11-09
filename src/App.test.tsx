import { StrictMode } from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import App from "./App";
import { LanguageProvider } from "./context/LanguageContext";
import { ThemeProvider } from "./context/ThemeContext";
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

const VAULT_PATH = "/vaults/passdroid.pdvault";
const MASTER = "clave-maestra-123";

let backend: FakeBackend;

beforeEach(() => {
  // language "es" fija los textos en castellano, que son los que aseguran estos tests.
  backend = new FakeBackend({ preferences: { language: "es" } });
  backend.seedVault({
    path: VAULT_PATH,
    masterPassword: MASTER,
    entries: [
      { title: "GitHub", username: "alexwing", password: "gh-secret", url: "https://github.com" },
      { title: "Banco", username: "alex", password: "bank-secret" },
    ],
  });
  installFakeIpc(backend);
});

afterEach(() => {
  // Desmontar antes de quitar el mock: el cleanup de TitleBar llama a unlisten, que
  // usa los internals que clearMocks borra.
  cleanup();
  uninstallFakeIpc();
});

// Recorre el flujo de la UI real: Inicio -> "Abrir fichero" (diálogo) -> desbloqueo.
async function unlockViaOpenDialog(user: ReturnType<typeof userEvent.setup>) {
  backend.setOpenDialogResult(VAULT_PATH);
  await user.click(await screen.findByRole("button", { name: "Abrir fichero" }));
  await user.type(await screen.findByLabelText("Clave maestra"), MASTER);
  await user.click(screen.getByRole("button", { name: "Desbloquear" }));
  // Al desbloquear la app pasa a la pantalla del vault: aparece la lista.
  await screen.findByRole("button", { name: /GitHub/ });
}

// El botón Guardar vive en el pie del editor. Su "Eliminar" de cabecera es solo de
// móvil (oculto en escritorio), así que el borrado se busca dentro de ese pie.
function editorFooter(): HTMLElement {
  return screen.getByRole("button", { name: "Guardar" }).closest("footer") as HTMLElement;
}

describe("Passdroid Next: flujo de la UI con IPC falsa", () => {
  it("abre el vault sembrado desde el diálogo, desbloquea y muestra sus entradas", async () => {
    const user = userEvent.setup();
    renderApp();

    await unlockViaOpenDialog(user);

    expect(screen.getByRole("button", { name: /Banco/ })).toBeInTheDocument();
    expect(screen.getByText("2 entradas")).toBeInTheDocument();
    expect(backend.snapshot().unlocked).toBe(true);
    expect(backend.snapshot().revision).toBe(1);
  });

  it("muestra error si la clave maestra es incorrecta y no abre el vault", async () => {
    const user = userEvent.setup();
    renderApp();
    backend.setOpenDialogResult(VAULT_PATH);

    await user.click(await screen.findByRole("button", { name: "Abrir fichero" }));
    await user.type(await screen.findByLabelText("Clave maestra"), "clave-equivocada");
    await user.click(screen.getByRole("button", { name: "Desbloquear" }));

    // El error va inline bajo el campo (role=alert), no como toast.
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("La clave maestra no es correcta.");
    // Seguimos en la pantalla de desbloqueo, sin entradas en pantalla. El texto del
    // error forma parte del <label>, así que el nombre del campo se busca por regex.
    expect(screen.getByLabelText(/Clave maestra/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /GitHub/ })).not.toBeInTheDocument();
    expect(backend.snapshot().unlocked).toBe(false);
  });

  it("crea una entrada nueva y aparece en la lista y en el fichero guardado", async () => {
    const user = userEvent.setup();
    renderApp();
    await unlockViaOpenDialog(user);

    // "Nueva" es el botón de la cabecera de la lista en escritorio (el FAB "Nueva entrada" es de móvil).
    await user.click(screen.getByRole("button", { name: "Nueva" }));
    await user.type(screen.getByLabelText("Título", { selector: "input" }), "Gmail");
    await user.type(screen.getByLabelText("Usuario", { selector: "input" }), "alex@gmail.com");
    await user.type(screen.getByLabelText("Contraseña", { selector: "input" }), "mail-secret-1");
    await user.click(screen.getByRole("button", { name: "Guardar" }));

    expect(await screen.findByRole("button", { name: /Gmail/ })).toBeInTheDocument();
    expect(screen.getByText("3 entradas")).toBeInTheDocument();

    const state = backend.snapshot();
    expect(state.visibleEntries.map((e) => e.title)).toEqual(["Banco", "GitHub", "Gmail"]);
    expect(state.revision).toBe(2);
    // La app persiste el resultado en el mismo fichero que se abrió.
    expect(JSON.parse(backend.fileText(VAULT_PATH) ?? "{}").revision).toBe(2);
  });

  it("edita una entrada existente y el cambio se refleja en la lista", async () => {
    const user = userEvent.setup();
    renderApp();
    await unlockViaOpenDialog(user);
    const idBefore = backend.snapshot().visibleEntries.find((e) => e.title === "GitHub")?.id;

    await user.click(screen.getByRole("button", { name: /GitHub/ }));
    const titleInput = await screen.findByLabelText("Título", { selector: "input" });
    expect(titleInput).toHaveValue("GitHub");
    await user.clear(titleInput);
    await user.type(titleInput, "GitHub Work");
    await user.click(screen.getByRole("button", { name: "Guardar" }));

    expect(await screen.findByRole("button", { name: /GitHub Work/ })).toBeInTheDocument();
    expect(screen.queryByText("GitHub", { exact: true })).not.toBeInTheDocument();
    expect(screen.getByText("2 entradas")).toBeInTheDocument();

    const edited = backend.snapshot().visibleEntries.find((e) => e.title === "GitHub Work");
    expect(edited?.id).toBe(idBefore);
    expect(edited?.username).toBe("alexwing");
  });

  it("borra una entrada tras confirmarlo: desaparece de la lista y queda como tombstone en el vault", async () => {
    const user = userEvent.setup();
    renderApp();
    await unlockViaOpenDialog(user);

    await user.click(screen.getByRole("button", { name: /Banco/ }));
    await user.click(within(editorFooter()).getByRole("button", { name: "Eliminar" }));
    // Borrar pide confirmación en un diálogo cuyo título es el nombre de la entrada.
    const dialog = await screen.findByRole("dialog", { name: "Banco" });
    await user.click(within(dialog).getByRole("button", { name: "Eliminar" }));

    expect(await screen.findByText("1 entrada")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Banco/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /GitHub/ })).toBeInTheDocument();
    const deleted = backend.snapshot().entries.find((e) => e.title === "Banco");
    expect(deleted?.deletedAt).toEqual(expect.any(String));
  });
});
