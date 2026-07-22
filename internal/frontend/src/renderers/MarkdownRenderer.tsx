import { useEffect, useLayoutEffect, useRef, useState, useCallback, useMemo } from "react";
import Markdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import rehypeSlug from "rehype-slug";
import rehypeKatex from "rehype-katex";
import { rehypeGithubAlerts } from "rehype-github-alerts";
import { rehypeCheckboxIndices } from "../plugins/rehypeCheckboxIndices";
import { useCheckboxState } from "../hooks/useCheckboxState";
import "katex/dist/katex.min.css";
import { codeToHtml } from "shiki";
import mermaid from "mermaid";
import { openRelativeFile } from "../hooks/useApi";
import { isPlainLeftClick } from "../utils/linkClick";
import { escapeRegExp } from "../utils/regex";
import { resolveLink, resolveImageSrc, extractLanguage } from "../utils/resolve";
import { buildRelativeOpenUrl } from "../utils/groups";
import { parseFrontmatter } from "../utils/frontmatter";
import { stripMdxSyntax } from "../utils/mdx";
import type { TextRendererProps, TocHeading } from "./registry";
import type { ZoomContent } from "../components/ZoomModal";
import type { Components } from "react-markdown";
import "github-markdown-css/github-markdown.css";

// Strip the `user-content-` prefix that remark-gfm bakes into footnote IDs,
// so rehype-sanitize can re-add it exactly once (avoiding double-prefixed IDs).
function rehypeStripClobberPrefix() {
  const FOOTNOTE_ID_PATTERN = /^user-content-(fn-|fnref-|footnote-label$)/;
  const PREFIX = "user-content-";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function walk(node: any) {
    if (node.properties) {
      const props = node.properties;
      if (typeof props.id === "string" && FOOTNOTE_ID_PATTERN.test(props.id)) {
        props.id = props.id.slice(PREFIX.length);
      }
    }
    if (node.children) {
      for (const child of node.children) {
        if (child.type === "element") walk(child);
      }
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (tree: any) => {
    walk(tree);
  };
}

// Extend default GitHub-compatible schema to allow style/align attributes used in raw HTML
const sanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    span: [...(defaultSchema.attributes?.["span"] || []), "style"],
    div: [...(defaultSchema.attributes?.["div"] || []), "style", "align"],
    input: [...(defaultSchema.attributes?.["input"] || []), "dataCheckboxKey"],
  },
  protocols: {
    ...defaultSchema.protocols,
    src: [...(defaultSchema.protocols?.["src"] || []), "data"],
  },
};

// react-markdown's defaultUrlTransform drops every data: URI, on top of
// rehype-sanitize. Restrict the exception to data:image/ on src: img is
// script-inert for data URIs, while data:text/html on href would be a vector.
function urlTransform(url: string, key: string): string {
  if (key === "src" && url.startsWith("data:image/")) {
    return url;
  }
  return defaultUrlTransform(url);
}

interface SearchHitMarker {
  top: number;
  height: number;
}

const SEARCH_HIT_COLUMN_OFFSET = -24;

function collectSearchHitMarkers(root: HTMLElement, query: string): SearchHitMarker[] {
  const trimmed = query.trim();
  if (!trimmed) {
    return [];
  }

  const pattern = new RegExp(escapeRegExp(trimmed), "gi");
  const articleRect = root.getBoundingClientRect();
  const markers = new Map<string, SearchHitMarker>();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (
        parent == null ||
        parent.closest("script, style, .frontmatter-block") != null ||
        node.textContent == null ||
        node.textContent.trim() === ""
      ) {
        return NodeFilter.FILTER_REJECT;
      }
      pattern.lastIndex = 0;
      return pattern.test(node.textContent) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });

  let current = walker.nextNode();
  while (current != null) {
    if (current instanceof Text) {
      const text = current.textContent ?? "";
      pattern.lastIndex = 0;
      for (const match of text.matchAll(pattern)) {
        const start = match.index ?? 0;
        const end = start + match[0].length;
        const range = document.createRange();
        range.setStart(current, start);
        range.setEnd(current, end);
        const [rect] = Array.from(range.getClientRects());
        if (rect != null && rect.height > 0 && rect.width > 0) {
          const top = rect.top - articleRect.top;
          const height = rect.height;
          const key = `${Math.round(top)}:${Math.round(height)}`;
          markers.set(key, {
            top,
            height,
          });
        }
      }
    }
    current = walker.nextNode();
  }

  return [...markers.values()].sort((a, b) => a.top - b.top);
}

function getMermaidTheme(): "dark" | "default" {
  return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "default";
}

let mermaidCounter = 0;
let mermaidQueue: Promise<void> = Promise.resolve();

function cleanupMermaidErrors() {
  document.querySelectorAll("[id^='dmermaid-']").forEach((el) => el.remove());
}

async function renderMermaid(code: string, width?: number): Promise<string> {
  let resolve: (svg: string) => void;
  let reject: (err: unknown) => void;
  const result = new Promise<string>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  mermaidQueue = mermaidQueue.then(async () => {
    const id = `mermaid-${++mermaidCounter}`;
    const container = document.createElement("div");
    container.style.position = "absolute";
    container.style.left = "-9999px";
    container.style.top = "-9999px";
    container.style.width = `${width && width > 0 ? width : 800}px`;
    document.body.appendChild(container);
    try {
      const { svg } = await mermaid.render(id, code, container);
      resolve!(svg);
    } catch (err) {
      reject!(err);
    } finally {
      container.remove();
      cleanupMermaidErrors();
    }
  });

  return result;
}

export function MermaidBlock({
  code,
  onZoom,
}: {
  code: string;
  onZoom?: (content: ZoomContent) => void;
}) {
  const [svg, setSvg] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;

    const doRender = () => {
      const width = containerRef.current?.offsetWidth;
      mermaid.initialize({ startOnLoad: false, theme: getMermaidTheme() });
      renderMermaid(code, width)
        .then((renderedSvg) => {
          if (!cancelled) setSvg(renderedSvg);
        })
        .catch(() => {
          if (!cancelled) setSvg("");
        });
    };

    doRender();

    // Re-render on theme change
    const observer = new MutationObserver(() => doRender());
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });

    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [code]);

  if (svg) {
    return (
      <div ref={containerRef} className="relative group">
        <div className="overflow-x-auto" dangerouslySetInnerHTML={{ __html: svg }} />
        {onZoom && <ZoomButton onClick={() => onZoom({ type: "svg", svg })} position="right-18" />}
        <MermaidImageCopyButton svg={svg} />
        <CodeBlockCopyButton code={code} themed />
      </div>
    );
  }
  return (
    <div ref={containerRef} className="relative group">
      <pre>
        <code>{code}</code>
      </pre>
      <CodeBlockCopyButton code={code} />
    </div>
  );
}

function MermaidImageCopyButton({ svg }: { svg: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  const handleCopy = async () => {
    try {
      // Pass the Blob promise directly to ClipboardItem so clipboard.write() is
      // invoked synchronously inside the user gesture. Awaiting the blob first
      // lets the transient user activation expire on Chrome and breaks the
      // user-gesture requirement on Safari/WebKit, both surfacing as a silent
      // no-op click.
      await navigator.clipboard.write([new ClipboardItem({ "image/png": svgToPngBlob(svg) })]);
      setCopied(true);
    } catch (err) {
      console.error("mermaid copy image failed", err);
    }
  };

  return (
    <button
      className={`absolute right-10 top-2 flex items-center justify-center rounded-md p-1 cursor-pointer transition-all duration-150 border ${themedButtonStyle} ${copied ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}
      onClick={handleCopy}
      title="Copy image"
    >
      {copied ? (
        <svg className="size-4" viewBox="0 0 16 16" fill="currentColor">
          <path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z" />
        </svg>
      ) : (
        <svg className="size-4" viewBox="0 0 16 16" fill="currentColor">
          <path d="M16 13.25A1.75 1.75 0 0 1 14.25 15H1.75A1.75 1.75 0 0 1 0 13.25V2.75C0 1.784.784 1 1.75 1h12.5c.966 0 1.75.784 1.75 1.75ZM1.75 2.5a.25.25 0 0 0-.25.25v10.5c0 .138.112.25.25.25h12.5a.25.25 0 0 0 .25-.25V2.75a.25.25 0 0 0-.25-.25Z" />
          <path
            d="M0.5 12.75 4.5 5.5 7.5 9 9.5 6.5 15.5 12.75"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinejoin="round"
          />
        </svg>
      )}
    </button>
  );
}

function svgToPngBlob(svgString: string): Promise<Blob> {
  return new Promise((resolve, reject) => {
    // Mermaid flowchart/stateDiagram labels embed HTML void elements such as
    // <br> inside <foreignObject>, which the strict "image/svg+xml" parser
    // rejects silently (documentElement becomes <html> and the width, height,
    // and viewBox lookups all return null). Parsing as "text/html" is lenient
    // and still preserves the case of SVG attributes (viewBox,
    // preserveAspectRatio, etc.). XMLSerializer then normalizes <br> to <br/>
    // so the resulting data URL loads cleanly as an SVG image.
    const parser = new DOMParser();
    const doc = parser.parseFromString(svgString, "text/html");
    const svgEl = doc.querySelector("svg");
    if (!svgEl) {
      reject(new Error("No SVG element found"));
      return;
    }

    // Ensure xmlns is present for standalone SVG rendering
    if (!svgEl.getAttribute("xmlns")) {
      svgEl.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    }

    // Extract dimensions from the SVG element
    const widthAttr = svgEl.getAttribute("width");
    const heightAttr = svgEl.getAttribute("height");
    const viewBox = svgEl.getAttribute("viewBox");

    let width = 0;
    let height = 0;

    if (widthAttr && heightAttr) {
      width = parseFloat(widthAttr);
      height = parseFloat(heightAttr);
    } else if (viewBox) {
      const parts = viewBox.split(/[\s,]+/);
      width = parseFloat(parts[2]);
      height = parseFloat(parts[3]);
    }

    if (!width || !height) {
      reject(new Error("Cannot determine SVG dimensions"));
      return;
    }

    // Scale up for high-DPI displays
    const scale = 4;
    const serializer = new XMLSerializer();
    const svgData = serializer.serializeToString(svgEl);
    const dataUrl = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svgData);

    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = width * scale;
      canvas.height = height * scale;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        reject(new Error("Failed to get canvas context"));
        return;
      }
      ctx.scale(scale, scale);
      ctx.drawImage(img, 0, 0, width, height);
      canvas.toBlob((blob) => {
        if (blob) {
          resolve(blob);
        } else {
          reject(new Error("Failed to create PNG blob"));
        }
      }, "image/png");
    };
    img.onerror = () => {
      reject(new Error("Failed to load SVG image"));
    };
    img.src = dataUrl;
  });
}

function ZoomButton({
  onClick,
  position = "right-2",
  groupClass = "group-hover:opacity-100",
}: {
  onClick: () => void;
  position?: string;
  groupClass?: string;
}) {
  return (
    <button
      className={`absolute ${position} top-2 flex items-center justify-center rounded-md p-1 cursor-pointer transition-all duration-150 border ${themedButtonStyle} opacity-0 ${groupClass}`}
      onClick={onClick}
      title="Zoom"
    >
      {/* Placeholder icon — will be replaced */}
      <svg
        className="size-4"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      >
        <circle cx="7" cy="7" r="4.5" />
        <line x1="10.5" y1="10.5" x2="14" y2="14" strokeLinecap="round" />
        <line x1="5" y1="7" x2="9" y2="7" strokeLinecap="round" />
        <line x1="7" y1="5" x2="7" y2="9" strokeLinecap="round" />
      </svg>
    </button>
  );
}

const darkButtonStyle = "border-[#484f58] hover:border-[#8b949e] text-[#8b949e] bg-[#2d333b]";
const themedButtonStyle =
  "border-gh-border hover:border-gh-text-secondary text-gh-text-secondary bg-gh-bg-secondary";

function CodeBlockCopyButton({ code, themed = false }: { code: string; themed?: boolean }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
    } catch {
      // clipboard API may fail in insecure contexts
    }
  };

  const colorStyle = themed ? themedButtonStyle : darkButtonStyle;

  return (
    <button
      className={`absolute right-2 top-2 flex items-center justify-center rounded-md p-1 cursor-pointer transition-all duration-150 border ${colorStyle} ${copied ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}
      onClick={handleCopy}
      title="Copy code"
    >
      {copied ? (
        <svg className="size-4" viewBox="0 0 16 16" fill="currentColor">
          <path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z" />
        </svg>
      ) : (
        <svg className="size-4" viewBox="0 0 16 16" fill="currentColor">
          <path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25ZM5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z" />
        </svg>
      )}
    </button>
  );
}

function CodeBlock({ language, code }: { language: string; code: string }) {
  const [html, setHtml] = useState("");

  useEffect(() => {
    let cancelled = false;
    codeToHtml(code, { lang: language, theme: "github-dark" })
      .then((result) => {
        if (!cancelled) setHtml(result);
      })
      .catch(() => {
        // Fallback: if language not supported, try plaintext
        if (!cancelled) {
          codeToHtml(code, { lang: "text", theme: "github-dark" })
            .then((result) => {
              if (!cancelled) setHtml(result);
            })
            .catch(() => {});
        }
      });
    return () => {
      cancelled = true;
    };
  }, [code, language]);

  if (html) {
    return (
      <div className="relative group">
        <div dangerouslySetInnerHTML={{ __html: html }} />
        <CodeBlockCopyButton code={code} />
      </div>
    );
  }
  return (
    <div className="relative group">
      <pre>
        <code>{code}</code>
      </pre>
      <CodeBlockCopyButton code={code} />
    </div>
  );
}

function FrontmatterBlock({ yaml }: { yaml: string }) {
  return (
    <details open className="mb-4">
      <summary className="cursor-pointer select-none text-gh-text-secondary text-sm font-medium py-1">
        Metadata
      </summary>
      <div className="mt-2">
        <CodeBlock language="yaml" code={yaml} />
      </div>
    </details>
  );
}

function HighlightedView({ content, language }: { content: string; language: string }) {
  const [html, setHtml] = useState("");

  useEffect(() => {
    let cancelled = false;
    setHtml("");
    codeToHtml(content, { lang: language, theme: "github-dark" })
      .then((result) => {
        if (!cancelled) setHtml(result);
      })
      .catch(() => {
        if (!cancelled) {
          codeToHtml(content, { lang: "text", theme: "github-dark" })
            .then((result) => {
              if (!cancelled) setHtml(result);
            })
            .catch(() => {});
        }
      });
    return () => {
      cancelled = true;
    };
  }, [content, language]);

  if (html) {
    return <div className="[&_pre]:!rounded-none" dangerouslySetInnerHTML={{ __html: html }} />;
  }
  return (
    <pre>
      <code>{content}</code>
    </pre>
  );
}

function RawView({ content }: { content: string }) {
  return <HighlightedView content={content} language="markdown" />;
}

export function MarkdownRenderer({
  activeGroup,
  fileId,
  fileName,
  content,
  revision: _revision,
  isRawView,
  onFileOpened,
  onHeadingsChange,
  onContentRendered,
  onCheckboxInfo,
  onZoom,
  scrollToHeading,
  onScrolledToHeading,
  searchQuery,
}: TextRendererProps) {
  const articleRef = useRef<HTMLDivElement>(null);
  const pendingHashRef = useRef<string>("");
  const [searchHitMarkers, setSearchHitMarkers] = useState<SearchHitMarker[]>([]);

  const {
    getChecked,
    toggle,
    uncheckAll,
    checkAll,
    hasCheckboxes,
    totalCheckboxes,
    orderedKeys,
    checkboxesLoaded,
    checkboxRevision,
  } = useCheckboxState(activeGroup, fileId);

  // Use refs for checkbox callbacks so the components useMemo stays stable
  // across checkbox state changes, preventing full re-render flicker.
  const getCheckedRef = useRef(getChecked);
  getCheckedRef.current = getChecked;
  const toggleRef = useRef(toggle);
  toggleRef.current = toggle;

  useEffect(() => {
    onCheckboxInfo?.({ hasCheckboxes, totalCheckboxes, uncheckAll, checkAll });
  }, [hasCheckboxes, totalCheckboxes, uncheckAll, checkAll, onCheckboxInfo]);

  const handleLinkClick = useCallback(
    async (e: React.MouseEvent<HTMLAnchorElement>, href: string, hash: string) => {
      e.preventDefault();
      try {
        pendingHashRef.current = hash;
        const entry = await openRelativeFile(activeGroup, fileId, href);
        onFileOpened?.(entry.id, hash);
      } catch {
        pendingHashRef.current = "";
      }
    },
    [activeGroup, fileId, onFileOpened],
  );

  const components: Components = useMemo(
    () => ({
      pre: ({ children }) => <>{children}</>,
      code: ({ className, children, ...props }) => {
        const language = extractLanguage(className);
        const code = String(children).replace(/\n$/, "");
        const isBlock = String(children).endsWith("\n");
        if (language) {
          if (language === "mermaid") {
            return <MermaidBlock code={code} onZoom={onZoom} />;
          }
          return <CodeBlock language={language} code={code} />;
        }
        if (isBlock) {
          return <CodeBlock language="text" code={code} />;
        }
        return (
          <code className={className} {...props}>
            {children}
          </code>
        );
      },
      img: ({ src, alt, ...props }) => {
        const resolvedSrc = resolveImageSrc(src, activeGroup, fileId);
        if (onZoom && resolvedSrc) {
          return (
            <span className="relative inline-block group/img">
              <img src={resolvedSrc} alt={alt} {...props} />
              <ZoomButton
                onClick={() => onZoom({ type: "image", src: resolvedSrc, alt: alt ?? undefined })}
                position="right-1"
                groupClass="group-hover/img:opacity-100"
              />
            </span>
          );
        }
        return <img src={resolveImageSrc(src, activeGroup, fileId)} alt={alt} {...props} />;
      },
      a: ({ href, children, ...props }) => {
        const resolved = resolveLink(href, activeGroup, fileId);
        switch (resolved.type) {
          case "external":
            return (
              <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
                {children}
              </a>
            );
          case "hash":
            return (
              <a
                href={href}
                onClick={(e) => {
                  if (!isPlainLeftClick(e)) return;
                  const id = href?.slice(1);
                  if (!id) return;
                  const target = document.getElementById(id);
                  if (target) {
                    e.preventDefault();
                    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
                    target.scrollIntoView({
                      behavior: reduced ? "auto" : "smooth",
                      block: "start",
                    });
                    history.pushState(null, "", href);
                  }
                }}
                {...props}
              >
                {children}
              </a>
            );
          case "markdown":
            return (
              <a
                href={buildRelativeOpenUrl(activeGroup, fileId, resolved.hrefPath, resolved.hash)}
                onClick={(e) => {
                  // Modifier / middle clicks fall through so the browser opens the
                  // self-resolving href in a new tab (App resolves it on load); only a
                  // plain click navigates in place.
                  if (!isPlainLeftClick(e)) return;
                  handleLinkClick(e, resolved.hrefPath, resolved.hash);
                }}
                {...props}
              >
                {children}
              </a>
            );
          case "file":
            return (
              <a href={resolved.rawUrl} {...props}>
                {children}
              </a>
            );
          case "passthrough":
            return (
              <a href={href} {...props}>
                {children}
              </a>
            );
        }
      },
      li: ({ className, children, ...props }) => {
        const isTask = typeof className === "string" && className.includes("task-list-item");
        if (!isTask) {
          return (
            <li className={className} {...props}>
              {children}
            </li>
          );
        }
        // Extract checkbox key from children. Check direct children first,
        // then one level deeper (loose lists wrap content in <p>).
        let checkboxKey: string | undefined;
        const childArray = Array.isArray(children) ? children : [children];
        for (const child of childArray) {
          if (child && typeof child === "object" && "props" in child) {
            if (child.props?.type === "checkbox" && child.props?.["data-checkbox-key"]) {
              checkboxKey = child.props["data-checkbox-key"] as string;
              break;
            }
            // Check inside <p> wrapper (loose list items).
            const nested = child.props?.children;
            const nestedArray = Array.isArray(nested) ? nested : [nested];
            for (const inner of nestedArray) {
              if (
                inner &&
                typeof inner === "object" &&
                "props" in inner &&
                inner.props?.type === "checkbox" &&
                inner.props?.["data-checkbox-key"]
              ) {
                checkboxKey = inner.props["data-checkbox-key"] as string;
                break;
              }
            }
            if (checkboxKey) break;
          }
        }
        return (
          <li
            className={className}
            style={{
              cursor: checkboxKey ? "pointer" : undefined,
              borderRadius: "4px",
            }}
            onClick={(e) => {
              if (!checkboxKey) return;
              // Don't toggle if user was selecting text.
              const selection = window.getSelection();
              if (selection && selection.toString().length > 0) return;
              // Don't toggle if user clicked a link or button (e.g. code block copy).
              let target = e.target as HTMLElement | null;
              while (target && target !== e.currentTarget) {
                if (target.tagName === "A" || target.tagName === "BUTTON") return;
                target = target.parentElement;
              }
              // Don't toggle if user clicked the checkbox input directly (it has its own handler).
              if ((e.target as HTMLElement).tagName === "INPUT") return;
              toggleRef.current(checkboxKey);
            }}
            {...props}
          >
            {children}
          </li>
        );
      },
      input: ({ disabled: _disabled, type, checked, ...props }) => {
        if (type !== "checkbox") {
          return <input type={type} checked={checked} {...props} />;
        }
        const key = (props as Record<string, unknown>)["data-checkbox-key"] as string | undefined;
        if (!key) {
          return <input type="checkbox" checked={checked} disabled {...props} />;
        }
        const effectiveChecked = getCheckedRef.current(key);
        return (
          <input
            type="checkbox"
            checked={effectiveChecked}
            onChange={(e) => {
              // Prevent li handler from also firing.
              e.stopPropagation();
            }}
            onClick={() => {
              toggleRef.current(key);
            }}
            style={{ cursor: "pointer" }}
            {...props}
          />
        );
      },
    }),
    [activeGroup, fileId, handleLinkClick, onZoom],
  );

  const parsed = useMemo(
    () => (!isRawView ? parseFrontmatter(content) : null),
    [content, isRawView],
  );

  const previousRenderedRef = useRef<React.ReactNode>(null);

  const renderedContent = useMemo(() => {
    if (isRawView) {
      const node = <RawView content={content} />;
      previousRenderedRef.current = node;
      return node;
    }
    // Gate interactive rendering on checkbox keys being ready. While the
    // initial fetch is in flight, render the previously rendered tree (if
    // any) to avoid a flicker where checkboxes briefly appear unkeyed and
    // therefore disabled. On file switch, `checkboxesLoaded` resets to
    // false inside useCheckboxState and flips true once the new fetch
    // resolves.
    if (!checkboxesLoaded) {
      return previousRenderedRef.current ?? null;
    }
    const base = parsed ? parsed.content : content;
    const md = fileName.toLowerCase().endsWith(".mdx") ? stripMdxSyntax(base) : base;
    const node = (
      <>
        {parsed && <FrontmatterBlock yaml={parsed.yaml} />}
        <Markdown
          remarkPlugins={[remarkGfm, remarkMath]}
          rehypePlugins={[
            rehypeRaw,
            rehypeStripClobberPrefix,
            [rehypeCheckboxIndices, { orderedKeys }],
            [rehypeSanitize, sanitizeSchema],
            rehypeGithubAlerts,
            rehypeSlug,
            rehypeKatex,
          ]}
          components={components}
          urlTransform={urlTransform}
        >
          {md}
        </Markdown>
      </>
    );
    previousRenderedRef.current = node;
    return node;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    content,
    isRawView,
    parsed,
    components,
    fileName,
    checkboxRevision,
    checkboxesLoaded,
    orderedKeys,
  ]);

  const prevHeadingsKey = useRef("");
  useEffect(() => {
    if (renderedContent == null) return;
    const newHeadings: TocHeading[] = [];
    if (!isRawView && articleRef.current) {
      const els = articleRef.current.querySelectorAll("h1, h2, h3, h4, h5, h6");
      for (const el of els) {
        if (el.id) {
          newHeadings.push({
            id: el.id,
            text: el.textContent ?? "",
            level: parseInt(el.tagName.slice(1), 10),
          });
        }
      }
    }
    const key = newHeadings.map((h) => `${h.id}:${h.level}:${h.text}`).join(",");
    if (key !== prevHeadingsKey.current) {
      prevHeadingsKey.current = key;
      onHeadingsChange(newHeadings);
    }
  }, [isRawView, renderedContent, onHeadingsChange]);

  const onContentRenderedRef = useRef(onContentRendered);
  useLayoutEffect(() => {
    onContentRenderedRef.current = onContentRendered;
  });

  useLayoutEffect(() => {
    if (renderedContent == null) return;
    onContentRenderedRef.current?.();
    const hash = pendingHashRef.current;
    if (hash) {
      pendingHashRef.current = "";
      const target = document.getElementById(hash.slice(1));
      target?.scrollIntoView({ behavior: "instant" });
    }
  }, [renderedContent]);

  useLayoutEffect(() => {
    if (renderedContent == null || !scrollToHeading || !articleRef.current) return;

    const headings = articleRef.current.querySelectorAll("h1, h2, h3, h4, h5, h6");
    const target = Array.from(headings).find(
      (el) => (el.textContent ?? "").trim() === scrollToHeading,
    );
    if (target) {
      target.scrollIntoView({ behavior: "smooth", block: "start" });
      onScrolledToHeading?.();
    }
  }, [renderedContent, scrollToHeading, onScrolledToHeading]);

  useLayoutEffect(() => {
    if (renderedContent == null || !articleRef.current || isRawView || !searchQuery?.trim()) {
      setSearchHitMarkers([]);
      return;
    }

    const updateMarkers = () => {
      if (articleRef.current) {
        setSearchHitMarkers(collectSearchHitMarkers(articleRef.current, searchQuery));
      }
    };

    updateMarkers();
    const resizeObserver = new ResizeObserver(() => updateMarkers());
    resizeObserver.observe(articleRef.current);
    for (const element of articleRef.current.querySelectorAll("img, svg")) {
      resizeObserver.observe(element);
    }
    return () => resizeObserver.disconnect();
  }, [renderedContent, isRawView, searchQuery]);

  return (
    <div ref={articleRef} className="relative overflow-visible">
      <div className="pointer-events-none absolute inset-0 z-10 overflow-visible">
        {searchHitMarkers.map((marker, index) => (
          <div
            key={`${marker.top}:${marker.height}:${index}`}
            className="absolute w-1 rounded-none bg-gh-text/80"
            style={{
              left: SEARCH_HIT_COLUMN_OFFSET,
              top: marker.top,
              height: marker.height,
            }}
          />
        ))}
      </div>
      {renderedContent}
    </div>
  );
}
