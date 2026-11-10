/**
 * Entrada SOLO para los tests e2e de Playwright. No forma parte del build de
 * producción (vite.config.ts no la referencia, y `vite build` solo parte de
 * index.html).
 *
 * Replica el montaje de src/main.tsx con los mismos providers, pero antes
 * instala la IPC falsa con un vault sembrado, para que la UI real arranque
 * contra estado controlado. El FakeBackend queda en window.__fakeBackend para
 * que los tests puedan comprobar el estado.
 */
import React from "react";
import ReactDOM from "react-dom/client";
import App from "../../src/App";
import "../../src/styles.css";
import { LanguageProvider } from "../../src/context/LanguageContext";
import { ThemeProvider } from "../../src/context/ThemeContext";
import { FakeBackend } from "../../src/testing/fakeBackend";
import { installFakeIpc } from "../../src/testing/installFakeIpc";

// Mismo seed que src/App.test.tsx. Los tests de e2e dependen de estos valores.
const VAULT_PATH = "/vaults/passdroid.pdvault";
const MASTER_PASSWORD = "clave-maestra-123";

declare global {
  interface Window {
    __fakeBackend: FakeBackend;
  }
}

// language "es" fija los textos en castellano, que son los que aseguran los tests.
const backend = new FakeBackend({ preferences: { language: "es" } });
backend.seedVault({
  path: VAULT_PATH,
  masterPassword: MASTER_PASSWORD,
  entries: [
    { title: "GitHub", username: "alexwing", password: "gh-secret", url: "https://github.com" },
    { title: "Banco", username: "alex", password: "bank-secret" },
  ],
});
// "Abrir fichero" abre el diálogo nativo; aquí el diálogo devuelve el vault sembrado.
backend.setOpenDialogResult(VAULT_PATH);
installFakeIpc(backend);
window.__fakeBackend = backend;

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <LanguageProvider>
      <ThemeProvider>
        <App />
      </ThemeProvider>
    </LanguageProvider>
  </React.StrictMode>,
);
