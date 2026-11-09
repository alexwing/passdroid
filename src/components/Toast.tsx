import { useEffect, useState } from "react";
import { AlertTriangle, Check, X } from "lucide-react";
import { useTranslation } from "../context/LanguageContext";

export interface ToastNotice {
  kind: "success" | "error";
  text: string;
}

// Mirrors the 5 s auto-dismiss that App runs; the bar only visualises it.
const TOAST_MS = 5000;

// Success toasts show their text as the title; errors show a generic title plus
// the message as the single detail line, so nothing is repeated.
export function Toast({ notice, onClose }: { notice: ToastNotice; onClose: () => void }) {
  const { t } = useTranslation();
  const isError = notice.kind === "error";
  // A new notice object restarts the progress bar even if the text is identical.
  const [run, setRun] = useState(0);
  useEffect(() => {
    setRun((value) => value + 1);
  }, [notice]);

  return (
    <div className={`toast ${notice.kind}`} role={isError ? "alert" : "status"}>
      <div className="toast-icon" aria-hidden>
        {isError ? <AlertTriangle size={16} /> : <Check size={16} />}
      </div>
      <div className="toast-body">
        <strong>{isError ? t("error") : notice.text}</strong>
        {isError && <p>{notice.text}</p>}
      </div>
      <button className="icon-button toast-close" type="button" onClick={onClose} aria-label={t("close")} title={t("close")}>
        <X size={16} aria-hidden />
      </button>
      <span className="toast-bar" key={run} style={{ animationDuration: `${TOAST_MS}ms` }} aria-hidden />
    </div>
  );
}
