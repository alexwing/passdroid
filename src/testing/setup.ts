import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Sin `globals` en vitest, RTL no desmonta solo: lo hacemos aquí.
afterEach(() => {
  cleanup();
});

// jsdom no implementa scrollIntoView. La UI lo llama al enfocar el formulario de
// desbloqueo (para subir el botón con el teclado en Android): aquí basta un no-op.
if (typeof Element.prototype.scrollIntoView !== "function") {
  Element.prototype.scrollIntoView = () => {};
}
