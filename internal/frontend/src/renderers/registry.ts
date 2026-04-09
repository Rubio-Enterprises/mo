import { lazy, type ComponentType } from "react";
import type { FileType } from "../hooks/useApi";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { CodeRenderer } from "./CodeRenderer";
import { GenericRenderer } from "./GenericRenderer";
import { ImageRenderer } from "./ImageRenderer";

const PdfRenderer = lazy(() => import("./PdfRenderer").then((m) => ({ default: m.PdfRenderer })));

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

export interface CheckboxInfo {
  hasCheckboxes: boolean;
  totalCheckboxes: number;
  uncheckAll: () => void;
  checkAll: () => void;
}

interface BaseRendererProps {
  fileId: string;
  fileName: string;
  revision: number;
  isRawView: boolean;
  onFileOpened?: (fileId: string) => void;
  onHeadingsChange: (headings: TocHeading[]) => void;
  onContentRendered?: () => void;
  onCheckboxInfo?: (info: CheckboxInfo) => void;
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

export const rendererRegistry: Record<FileType, RendererEntry> = {
  markdown: {
    component: MarkdownRenderer as ComponentType<RendererProps>,
    features: { toc: true, raw: true, headings: true, copyable: true },
    contentSource: "text",
  },
  code: {
    component: CodeRenderer as ComponentType<RendererProps>,
    features: { toc: false, raw: false, headings: false, copyable: true },
    contentSource: "text",
  },
  pdf: {
    component: PdfRenderer as unknown as ComponentType<RendererProps>,
    features: { toc: false, raw: false, headings: false, copyable: false },
    contentSource: "raw",
  },
  image: {
    component: ImageRenderer as ComponentType<RendererProps>,
    features: { toc: false, raw: false, headings: false, copyable: false },
    contentSource: "raw",
  },
  binary: {
    component: GenericRenderer as ComponentType<RendererProps>,
    features: { toc: false, raw: false, headings: false, copyable: false },
    contentSource: "raw",
  },
  unknown: {
    component: CodeRenderer as ComponentType<RendererProps>,
    features: { toc: false, raw: false, headings: false, copyable: true },
    contentSource: "text",
  },
};
