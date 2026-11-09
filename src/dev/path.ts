// Browser-only stand-in for `@tauri-apps/api/path`.
export const appLocalDataDir = async () => "/mock/data";
export const join = async (...parts: string[]) => parts.join("/");
