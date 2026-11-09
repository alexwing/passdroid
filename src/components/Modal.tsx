import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { useTranslation } from "../context/LanguageContext";

interface ModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  // Small uppercase label above the title (section / context).
  eyebrow?: string;
  // Lucide icon shown before the title.
  icon?: ReactNode;
  // Extra class for size/variant tweaks (e.g. "qr-modal").
  className?: string;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

// Single dialog shell for the whole app: eyebrow + serif title + one X. Footers
// only carry real actions, so there is no redundant "Close" button.
export function Modal({ title, onClose, children, eyebrow, icon, className }: ModalProps) {
  const { t } = useTranslation();
  const dialogRef = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Escape closes, Tab stays inside the dialog, and focus goes back to the opener on close.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return undefined;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusables = () =>
      Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null);
    // Focus the dialog itself (not a field) so mobile keyboards do not pop up on open.
    dialog.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      // With stacked dialogs only the topmost one reacts.
      const open = document.querySelectorAll(".modal");
      if (open[open.length - 1] !== dialog) return;
      if (event.key === "Escape") {
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const head = items[0];
      const tail = items[items.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === head || active === dialog)) {
        event.preventDefault();
        tail.focus();
      } else if (!event.shiftKey && active === tail) {
        event.preventDefault();
        head.focus();
      } else if (!dialog.contains(active)) {
        event.preventDefault();
        head.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <section
        className={`modal${className ? ` ${className}` : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={dialogRef}
        onClick={(event) => event.stopPropagation()}
      >
        <header>
          <div className="modal-title">
            {eyebrow && <span className="eyebrow">{eyebrow}</span>}
            <h2>
              {icon}
              {title}
            </h2>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label={t("close")} title={t("close")}>
            <X size={18} aria-hidden />
          </button>
        </header>
        <div className="modal-body">{children}</div>
      </section>
    </div>
  );
}
