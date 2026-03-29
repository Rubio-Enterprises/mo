import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { codeToHtml } from "shiki";
import { useState } from "react";
import { detectLanguage } from "../utils/filetype";
import type { TextRendererProps } from "./registry";

export function CodeRenderer(props: TextRendererProps) {
  const { content, fileName, onHeadingsChange, onContentRendered } = props;
  const language = useMemo(() => detectLanguage(fileName), [fileName]);
  const [html, setHtml] = useState<string>("");

  useEffect(() => {
    let cancelled = false;
    codeToHtml(content, {
      lang: language,
      theme: "github-dark",
    })
      .then((result) => {
        if (!cancelled) setHtml(result);
      })
      .catch(() => {
        if (!cancelled) setHtml("");
      });
    return () => {
      cancelled = true;
    };
  }, [content, language]);

  // Code files have no headings.
  useEffect(() => {
    onHeadingsChange([]);
  }, [onHeadingsChange]);

  const onContentRenderedRef = useRef(onContentRendered);
  useLayoutEffect(() => {
    onContentRenderedRef.current = onContentRendered;
  });

  useEffect(() => {
    onContentRenderedRef.current?.();
  }, [html]);

  if (html) {
    return (
      <div
        className="[&_pre]:!rounded-none [&_pre]:!m-0"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  }

  return (
    <pre className="p-4 overflow-x-auto">
      <code>{content}</code>
    </pre>
  );
}
