import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Sin `globals` en vitest, RTL no desmonta solo: lo hacemos aquí.
afterEach(() => {
  cleanup();
});
