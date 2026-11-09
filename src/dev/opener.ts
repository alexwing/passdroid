// Browser-only stand-in for `@tauri-apps/plugin-opener`: never navigates anywhere.
export const openUrl = async (url: string) => {
  console.info("[mock] openUrl", url);
};
