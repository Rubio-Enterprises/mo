import type { ComponentType } from "react";
import type { FileType } from "../hooks/useApi";
import { MarkdownRenderer } from "./MarkdownRenderer";

export interface TocHeading {
  id: string;
  text: string;
  level: number;
}

export interface RendererFeatures {
  toc: boolean;
  raw: boolean;
  headings: boolean;
  copyable: boolean;
}

interface BaseRendererProps {
  fileId: string;
  fileName: string;
  revision: number;
  isRawView: boolean;
  onFileOpened?: (fileId: string) => void;
  onHeadingsChange: (headings: TocHeading[]) => void;
  onContentRendered?: () => void;
}

export type TextRendererProps = BaseRendererProps & {
  contentSource: "text";
  content: string;
};

export type RawRendererProps = BaseRendererProps & {
  contentSource: "raw";
  rawUrl: string;
};

export type RendererProps = TextRendererProps | RawRendererProps;

export interface RendererEntry {
  component: ComponentType<RendererProps>;
  features: RendererFeatures;
  contentSource: "text" | "raw";
}

// Placeholder components — replaced in subsequent tasks.
// Using inline stubs so the registry compiles before real renderers exist.
function Placeholder() {
  return null;
}

export const rendererRegistry: Record<FileType, RendererEntry> = {
  markdown: {
    component: MarkdownRenderer as ComponentType<RendererProps>,
    features: { toc: true, raw: true, headings: true, copyable: true },
    contentSource: "text",
  },
  code: {
    component: Placeholder as ComponentType<RendererProps>,
    features: { toc: false, raw: false, headings: false, copyable: true },
    contentSource: "text",
  },
  pdf: {
    component: Placeholder as ComponentType<RendererProps>,
    features: { toc: false, raw: false, headings: false, copyable: false },
    contentSource: "raw",
  },
  image: {
    component: Placeholder as ComponentType<RendererProps>,
    features: { toc: false, raw: false, headings: false, copyable: false },
    contentSource: "raw",
  },
  binary: {
    component: Placeholder as ComponentType<RendererProps>,
    features: { toc: false, raw: false, headings: false, copyable: false },
    contentSource: "raw",
  },
  unknown: {
    component: Placeholder as ComponentType<RendererProps>,
    features: { toc: false, raw: false, headings: false, copyable: true },
    contentSource: "text",
  },
};
