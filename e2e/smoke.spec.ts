import { expect, test, type Page } from "@playwright/test";

// Mismo seed que e2e/app/main.tsx.
const MASTER_PASSWORD = "clave-maestra-123";

// Recorre el flujo real: Inicio -> "Abrir fichero" (diálogo falso) -> desbloqueo.
async function openAndUnlock(page: Page, password = MASTER_PASSWORD) {
  await page.goto("/");
  await page.getByRole("button", { name: "Abrir fichero", exact: true }).click();
  await page.getByLabel("Clave maestra").fill(password);
  await page.getByRole("button", { name: "Desbloquear" }).click();
}

// Campo de formulario por su label. Los labels envuelven también botones de ayuda
// (copiar, mostrar), así que se acota al <input> para no depender del nombre accesible completo.
function field(page: Page, label: string) {
  return page.getByLabel(label, { exact: true }).and(page.locator("input"));
}

function isUnlocked(page: Page) {
  return page.evaluate(() => window.__fakeBackend.snapshot().unlocked);
}

test.describe("smoke: vault con IPC falsa", () => {
  test("abre y desbloquea el vault sembrado y muestra la lista con su contador", async ({ page }) => {
    await openAndUnlock(page);

    await expect(page.getByRole("button", { name: /GitHub/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Banco/ })).toBeVisible();
    await expect(page.getByText("2 entradas", { exact: true })).toBeVisible();
    expect(await isUnlocked(page)).toBe(true);
  });

  test("clave incorrecta muestra el error y no abre el vault", async ({ page }) => {
    await openAndUnlock(page, "clave-equivocada");

    await expect(page.getByRole("alert")).toContainText("La clave maestra no es correcta.");
    await expect(page.getByLabel("Clave maestra")).toBeVisible();
    await expect(page.getByRole("button", { name: /GitHub/ })).toHaveCount(0);
    expect(await isUnlocked(page)).toBe(false);
  });

  test("crea una entrada nueva y aparece en la lista", async ({ page }) => {
    await openAndUnlock(page);

    // "Nueva" es el botón de la cabecera de la lista (en escritorio); el FAB "Nueva entrada" es de móvil.
    await page.getByRole("button", { name: "Nueva", exact: true }).click();
    await field(page, "Título").fill("Gmail");
    await field(page, "Usuario").fill("alex@gmail.com");
    await field(page, "Contraseña").fill("mail-secret-1");
    await page.getByRole("button", { name: "Guardar" }).click();

    await expect(page.getByRole("button", { name: /Gmail/ })).toBeVisible();
    await expect(page.getByText("3 entradas", { exact: true })).toBeVisible();
    // El resultado se persiste en el mismo fichero: la revisión sube a 2.
    const revision = await page.evaluate(() => window.__fakeBackend.snapshot().revision);
    expect(revision).toBe(2);
  });

  test("edita una entrada existente y el cambio se refleja en la lista", async ({ page }) => {
    await openAndUnlock(page);

    await page.getByRole("button", { name: /GitHub/ }).click();
    const title = field(page, "Título");
    await expect(title).toHaveValue("GitHub");
    await title.fill("GitHub Work");
    await page.getByRole("button", { name: "Guardar" }).click();

    await expect(page.getByRole("button", { name: /GitHub Work/ })).toBeVisible();
    await expect(page.getByText("GitHub", { exact: true })).toHaveCount(0);
    await expect(page.getByText("2 entradas", { exact: true })).toBeVisible();
  });
});
