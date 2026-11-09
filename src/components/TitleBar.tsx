import { useEffect, useState, type ReactNode } from "react";
import { Copy, Minus, Square, X } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import appIcon from "../assets/passdroid.png";
import { useTranslation } from "../context/LanguageContext";

// Desktop-only replacement for the native title bar (window `decorations` are
// off in tauri.conf.json). Dragging and double-click-to-maximize come from
// `data-tauri-drag-region`; the buttons call the window API directly. App never
// renders this on Android.
export function TitleBar({ title, children }: { title: string; children?: ReactNode }) {
  const { t } = useTranslation();
  const [maximized, setMaximized] = useState(false);

  // Keep the maximize/restore icon in sync with the real window state, which
  // also changes from outside the bar (Snap, double-click, keyboard).
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    try {
      const win = getCurrentWindow();
      const sync = () =>
        win
          .isMaximized()
          .then((value) => {
            if (!disposed) setMaximized(value);
          })
          .catch(() => {});
      void sync();
      win
        .onResized(() => void sync())
        .then((fn) => {
          if (disposed) fn();
          else unlisten = fn;
        })
        .catch(() => {});
    } catch {
      // Not running inside Tauri (plain browser dev): the bar is inert.
    }
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const act = (action: "minimize" | "toggleMaximize" | "close") => {
    try {
      void getCurrentWindow()[action]().catch(() => {});
    } catch {
      /* not running inside Tauri */
    }
  };

  const maximizeLabel = maximized ? t("windowRestore") : t("windowMaximize");

  return (
    <div className="titlebar" data-tauri-drag-region>
      <img className="titlebar-logo" src={appIcon} alt="" width={18} height={18} draggable={false} />
      <span className="titlebar-title">{title}</span>
      {children}
      <span className="titlebar-spacer" />
      <button className="tb-btn" type="button" onClick={() => act("minimize")} aria-label={t("windowMinimize")} title={t("windowMinimize")}>
        <Minus size={14} aria-hidden />
      </button>
      <button className="tb-btn" type="button" onClick={() => act("toggleMaximize")} aria-label={maximizeLabel} title={maximizeLabel}>
        {maximized ? <Copy size={13} aria-hidden /> : <Square size={13} aria-hidden />}
      </button>
      <button className="tb-btn close" type="button" onClick={() => act("close")} aria-label={t("close")} title={t("close")}>
        <X size={14} aria-hidden />
      </button>
    </div>
  );
}
