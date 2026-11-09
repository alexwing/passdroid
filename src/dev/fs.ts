// Browser-only stand-in for `@tauri-apps/plugin-fs`: an in-memory file map.
const files = new Map<string, string>();

export const mkdir = async () => {};
export const readTextFile = async (path: string) => files.get(path) ?? "MOCK-VAULT-REV-1";
export const writeTextFile = async (path: string, contents: string) => {
  files.set(path, contents);
};
export const readFile = async (path: string) => new TextEncoder().encode(files.get(path) ?? "MOCK");
