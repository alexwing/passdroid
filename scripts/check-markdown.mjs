// Checks that hostile note content renders inert. Run: node scripts/check-markdown.mjs
// Bundles the real NotesMarkdown with esbuild (a Vite dependency) and renders it to static HTML.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = resolve(import.meta.dirname, "..");
const posix = (path) => join(root, path).replaceAll("\\", "/");
const out = mkdtempSync(join(tmpdir(), "passdroid-md-"));
const entry = join(out, "entry.tsx");
writeFileSync(
  entry,
  `import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LanguageProvider } from ${JSON.stringify(posix("src/context/LanguageContext.tsx"))};
import { NotesMarkdown, safeUrl, deceptiveLinkTarget } from ${JSON.stringify(posix("src/components/NotesMarkdown.tsx"))};
import { exceedsMarkdownLimits } from ${JSON.stringify(posix("src/utils/markdownGuard.ts"))};
export const render = (source) =>
  renderToStaticMarkup(createElement(LanguageProvider, null, createElement(NotesMarkdown, { source, onOpenLink: () => {} })));
export { safeUrl, deceptiveLinkTarget, exceedsMarkdownLimits };
`,
);
const bundle = join(out, "bundle.mjs");
await build({
  entryPoints: [entry],
  outfile: bundle,
  bundle: true,
  format: "esm",
  platform: "node",
  jsx: "automatic",
  nodePaths: [join(root, "node_modules")],
  banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
  logLevel: "error",
});
const { render, safeUrl, deceptiveLinkTarget, exceedsMarkdownLimits } = await import(pathToFileURL(bundle).href);

let failures = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${name}\n     ${String(error.message).split("\n")[0]}`);
  }
};

// Nothing a note can contain may produce an executable or loading element or a navigable attribute.
const inert = (rendered) => {
  // The app's own lucide icons are the only SVG allowed (aria-hidden, no handlers or links).
  const html = rendered.replace(/<svg [^>]*class="lucide [^"]*"[^>]*>.*?<\/svg>/g, "");
  assert.ok(!/<(script|iframe|object|embed|style|form|svg|link|meta|base|img|a)\b/i.test(html), "dangerous element in: " + html);
  assert.ok(!/<[^>]*\son\w+=/i.test(html), "event handler attribute in: " + html);
  assert.ok(!/<[^>]*\b(href|src|srcset|action|formaction)=/i.test(html), "navigable attribute in: " + html);
};

const hostile = {
  "raw script tag": "<script>alert(1)</script>",
  "raw img onerror": '<img src=x onerror="alert(1)">',
  "raw iframe": '<iframe src="https://evil.example"></iframe>',
  "raw svg onload": "<svg onload=alert(1)>",
  "javascript link": "[x](javascript:alert(1))",
  "javascript link uppercase": "[x](JAVASCRIPT:alert(1))",
  "javascript link entity": "[x](&#106;avascript:alert(1))",
  "javascript link tab": "[x](java\tscript:alert(1))",
  "vbscript link": "[x](vbscript:msgbox(1))",
  "data link": "[x](data:text/html;base64,PHNjcmlwdD4=)",
  "file link": "[x](file:///C:/Windows/win.ini)",
  "relative link": "[x](/etc/passwd)",
  "protocol-relative link": "[x](//evil.example/a)",
  "javascript reference link": "[x][r]\n\n[r]: javascript:alert(1)",
  "javascript autolink": "<javascript:alert(1)>",
  "remote image": "![alt](https://evil.example/pixel.png)",
  "data image": "![alt](data:image/svg+xml;base64,PHN2Zz4=)",
  "linked remote image": "[![alt](https://evil.example/p.png)](https://evil.example)",
};
for (const [name, src] of Object.entries(hostile)) {
  check(`inert: ${name}`, () => inert(render(src)));
}

check("remote image becomes a placeholder, never an <img>", () => {
  const html = render("![alt](https://evil.example/pixel.png)");
  assert.ok(html.includes("md-img") && !/<img\b/i.test(html));
});

check("http/https/mailto links are buttons", () => {
  assert.ok(render("[a](https://example.com/x)").includes('class="md-link"'));
  assert.ok(render("[a](mailto:me@example.com)").includes('class="md-link"'));
});

check("safeUrl rules", () => {
  assert.equal(safeUrl("https://example.com"), "https://example.com/");
  assert.equal(safeUrl("mailto:a@b.co"), "mailto:a@b.co");
  for (const bad of ["javascript:alert(1)", "JaVaScRiPt:1", "data:text/html,x", "file:///x", "blob:https://a/b", "/rel", "//host/p", "", "ftp://x"]) {
    assert.equal(safeUrl(bad), null, bad);
  }
});

check("misleading link text shows the real destination", () => {
  const html = render("[https://mibanco.es/login](https://mibanco-login.evil.example)");
  assert.ok(html.includes('class="md-link-host">(mibanco-login.evil.example)'), html);
});

check("credentials trick shows the real host", () => {
  const html = render("[https://mibanco.es](https://mibanco.es@evil.example/)");
  assert.ok(html.includes("(evil.example)"), html);
});

check("IDN homograph is shown in punycode", () => {
  const html = render("[bank.com](https://b\u0430nk.com)");
  assert.ok(html.includes("(xn--"), html);
});

check("mailto with a different visible address shows the real one", () => {
  const html = render("[boss@bank.com](mailto:evil@example.org)");
  assert.ok(html.includes("(evil@example.org)"), html);
});

check("links whose text already shows the target add nothing", () => {
  for (const src of ["<https://example.com/a>", "[https://example.com/a](https://example.com/a)", "[example.com](https://example.com/)", "www.example.com", "<me@example.com>"]) {
    assert.ok(!render(src).includes("md-link-host"), src);
  }
  assert.equal(deceptiveLinkTarget("Example.COM", "https://example.com/"), null);
});

const deep = {
  "'>' x3000": ">".repeat(3000) + " a",
  "'> ' x3000": "> ".repeat(3000) + "a",
  "'- ' x2000": "- ".repeat(2000) + "a",
  "'1. ' x2000": "1. ".repeat(2000) + "a",
};
for (const [name, src] of Object.entries(deep)) {
  check(`deep nesting guarded: ${name}`, () => {
    assert.ok(exceedsMarkdownLimits(src), "guard did not trigger");
    const html = render(src);
    assert.ok(html.includes("notes-plain") && !html.includes('class="md"'), html.slice(0, 200));
  });
}

check("deeply indented nested list stays renderable or guarded", () => {
  const src = Array.from({ length: 300 }, (_, i) => " ".repeat(i * 2) + "- a").join("\n");
  if (!exceedsMarkdownLimits(src)) render(src);
});

check("oversized note falls back to plain text", () => {
  const src = "a".repeat(64_001);
  assert.ok(exceedsMarkdownLimits(src));
  assert.ok(render(src).includes("notes-plain"));
});

check("plain fallback escapes HTML", () => {
  const html = render("<script>alert(1)</script>\n" + "> ".repeat(200) + "x");
  assert.ok(html.includes("&lt;script&gt;") && !/<script/i.test(html), html.slice(0, 200));
});

check("normal notes are not caught by the guard", () => {
  const samples = [
    "",
    "# Title\n\n- a\n  - b\n    - c\n\n> quote\n> > nested\n\n1. one\n2. two",
    "-".repeat(500),
    "*".repeat(500),
    "=".repeat(200) + "\n" + "- ".repeat(50) + "x",
  ];
  for (const src of samples) assert.equal(exceedsMarkdownLimits(src), false, src.slice(0, 30));
  assert.ok(render("**bold** and `code`").includes("<strong>bold</strong>"));
});

check("other pathological inputs under the limit do not overflow the stack", () => {
  const cases = [
    "[".repeat(20000),
    "![".repeat(10000),
    "*a ".repeat(10000),
    "<div>".repeat(10000),
    "(".repeat(30000),
    "|a".repeat(5000) + "|\n" + "|-".repeat(5000) + "|\n",
    "`".repeat(30000),
    "_a".repeat(10000),
  ];
  for (const src of cases) if (!exceedsMarkdownLimits(src)) render(src);
});

rmSync(out, { recursive: true, force: true });
if (failures) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
