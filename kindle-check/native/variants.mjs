import { readFileSync, writeFileSync } from 'node:fs';
const src = JSON.parse(readFileSync('../../fixtures/golden/android-32mib.pdvault', 'utf8'));
// 1) campo desconocido nuevo en header (Rust lo ignora al parsear y no entra en el AAD)
const h1 = { ...src.header, extra: 'x' };
writeFileSync('out/v-extra-field.pdvault', JSON.stringify({ header: h1, payload: src.payload }, null, 2));
// 2) mismos campos, orden en disco distinto (Rust: orden de struct en el AAD, indiferente al orden en disco)
const { nonce, cipher, ...rest } = src.header;
const h2 = { ...rest, nonce, cipher };
writeFileSync('out/v-reordered.pdvault', JSON.stringify({ header: h2, payload: src.payload }));
// 3) valor manipulado (updatedAt) -> debe fallar
writeFileSync('out/v-tampered.pdvault', JSON.stringify({ header: { ...src.header, updatedAt: '2030-01-01T00:00:00.000Z' }, payload: src.payload }, null, 2));
