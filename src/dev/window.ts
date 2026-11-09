// Browser-only stand-in for `@tauri-apps/api/window`: just enough for TitleBar.
let maximized = false;
const listeners = new Set<() => void>();

const win = {
  minimize: async () => {},
  close: async () => {},
  toggleMaximize: async () => {
    maximized = !maximized;
    listeners.forEach((fn) => fn());
  },
  isMaximized: async () => maximized,
  onResized: async (fn: () => void) => {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
};

export const getCurrentWindow = () => win;
