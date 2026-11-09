/**
 * Enruta toda llamada IPC de Tauri (`invoke` de @tauri-apps/api/core, incluidos
 * los comandos de plugin) al FakeBackend. Sirve en vitest y en un navegador
 * normal (lo usará el smoke test de Playwright), porque solo toca
 * `window.__TAURI_INTERNALS__`.
 */
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { FakeBackend, type FakeInvokeOptions } from "./fakeBackend";

type TauriInternals = {
  invoke: (cmd: string, args?: unknown, options?: FakeInvokeOptions) => Promise<unknown>;
};

/**
 * Instala el fake como backend de IPC y devuelve la instancia para preparar
 * estado y hacer asserts.
 */
export function installFakeIpc(backend: FakeBackend = new FakeBackend()): FakeBackend {
  // mockIPC instala los internals (transformCallback, callbacks, etc.).
  mockIPC((cmd, args) => backend.invoke(cmd, args));

  // mockIPC no reenvía el tercer argumento de invoke. plugin-fs manda la ruta de
  // writeTextFile en options.headers, así que el enrutado final va por aquí.
  const internals = (window as unknown as { __TAURI_INTERNALS__: TauriInternals })
    .__TAURI_INTERNALS__;
  internals.invoke = (cmd, args, options) =>
    backend.invoke(cmd, args, options as FakeInvokeOptions | undefined);

  return backend;
}

/** Quita el mock de IPC instalado por installFakeIpc. */
export function uninstallFakeIpc(): void {
  clearMocks();
}
