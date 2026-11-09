// Browser-only stand-in for `@tauri-apps/plugin-dialog`: pickers return fixed fake paths.
export const open = async () => "/mock/vaults/Demo.pdvault";
export const save = async (options?: { defaultPath?: string }) =>
  `/mock/exports/${options?.defaultPath ?? "export.pdvault"}`;
