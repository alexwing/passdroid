import { Children, createContext, isValidElement, memo, useContext, useMemo, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { ImageOff } from "lucide-react";
import { useTranslation } from "../context/LanguageContext";
import { exceedsMarkdownLimits } from "../utils/markdownGuard";
import { NotesPlain } from "./NotesPlain";

interface NotesMarkdownProps {
  source: string;
  // Opens a vetted http/https/mailto URL outside the app.
  onOpenLink: (url: string) => void;
}

// Notes are untrusted text in a password manager, so the renderer is locked down:
// - no rehype-raw: embedded HTML is shown as plain text, never parsed or executed;
// - links are buttons that hand the URL to the system opener, so the webview never navigates;
// - remote images are never fetched (that would leak the user's IP when a note is opened),
//   they become a placeholder the user can click to open externally.
const SAFE_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);
const IMAGE_PROTOCOLS = new Set(["http:", "https:"]);

// Normalised absolute URL when the protocol is allowed, otherwise null. Relative URLs,
// javascript:, data:, file:, blob: and the like are all rejected.
export const safeUrl = (raw: string, protocols: Set<string> = SAFE_PROTOCOLS): string | null => {
  try {
    const parsed = new URL(raw.trim());
    return protocols.has(parsed.protocol) ? parsed.href : null;
  } catch {
    return null;
  }
};

// True while rendering inside a link, where an image must not nest a second interactive element.
const InLinkContext = createContext(false);

export const urlTransform = (url: string) => safeUrl(url) ?? "";

// Plain text of a link's children, to compare what the user reads with where the link goes.
const textOf = (node: ReactNode): string => {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return Children.toArray(node).map(textOf).join("");
};

const bare = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/^(?:https?:\/\/|mailto:)/, "")
    .replace(/\/$/, "");

// Where the link really goes (host, or address for mailto), shown next to links whose visible text
// says something else, so a "https://mybank.com" label cannot hide an attacker's host on touch
// screens, where the title tooltip never appears. Null when the text already shows the target.
export const deceptiveLinkTarget = (label: string, url: string): string | null => {
  const parsed = new URL(url);
  let target = parsed.host;
  if (parsed.protocol === "mailto:") {
    try {
      target = decodeURIComponent(parsed.pathname);
    } catch {
      target = parsed.pathname;
    }
  }
  const shown = bare(label);
  return shown === bare(url) || shown === bare(target) ? null : target;
};

function BlockedImage({ src, alt, onOpenLink }: { src: unknown; alt?: string; onOpenLink: (url: string) => void }) {
  const { t } = useTranslation();
  const inLink = useContext(InLinkContext);
  const url = typeof src === "string" ? safeUrl(src, IMAGE_PROTOCOLS) : null;
  const content = (
    <>
      <ImageOff size={14} aria-hidden />
      {alt || t("mdImageBlocked")}
    </>
  );
  // Linked images (and unusable sources) stay inert: the surrounding link is the action.
  if (!url || inLink) return <span className="md-img">{content}</span>;
  return (
    <button className="md-img" type="button" title={`${t("mdImageBlocked")}: ${url}`} onClick={() => onOpenLink(url)}>
      {content}
    </button>
  );
}

export const NotesMarkdown = memo(function NotesMarkdown({ source, onOpenLink }: NotesMarkdownProps) {
  const components = useMemo<Components>(
    () => ({
      a: ({ href, children }) => {
        const url = typeof href === "string" ? safeUrl(href) : null;
        if (!url) return <span>{children}</span>;
        const target = deceptiveLinkTarget(textOf(children), url);
        return (
          <>
            <button
              className="md-link"
              type="button"
              title={url}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onOpenLink(url);
              }}
            >
              <InLinkContext.Provider value>{children}</InLinkContext.Provider>
            </button>
            {target && <span className="md-link-host">({target})</span>}
          </>
        );
      },
      img: ({ src, alt }) => <BlockedImage src={src} alt={alt} onOpenLink={onOpenLink} />,
      input: ({ type, checked }) =>
        type === "checkbox" ? <input type="checkbox" checked={!!checked} disabled readOnly /> : null,
      table: ({ children }) => (
        <div className="md-table">
          <table>{children}</table>
        </div>
      ),
    }),
    [onOpenLink],
  );

  // Too big or too deeply nested to parse without overflowing the stack: show it as plain text.
  if (exceedsMarkdownLimits(source)) return <NotesPlain source={source} />;

  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={urlTransform} components={components}>
        {source}
      </ReactMarkdown>
    </div>
  );
});
