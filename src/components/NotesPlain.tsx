import { Component, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { useTranslation } from "../context/LanguageContext";

// Safe fallback: the note as escaped plain text (React text nodes are never parsed as HTML).
export function NotesPlain({ source }: { source: string }) {
  const { t } = useTranslation();
  return (
    <>
      <p className="notes-plain-warn" role="status">
        <AlertTriangle size={14} aria-hidden />
        {t("mdPlainFallback")}
      </p>
      <pre className="notes-plain">{source}</pre>
    </>
  );
}

interface NotesBoundaryProps {
  source: string;
  children: ReactNode;
}

// A render error in the Markdown preview (or its lazy chunk failing to load) must not unmount the
// whole app. Callers pass key={entry id} so the boundary resets when another entry is opened.
export class NotesBoundary extends Component<NotesBoundaryProps, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? <NotesPlain source={this.props.source} /> : this.props.children;
  }
}
