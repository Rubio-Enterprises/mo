import { describe, it, expect } from "vitest";
import { rendererRegistry } from "./registry";
import type { FileType } from "../hooks/useApi";

const allTypes: FileType[] = ["markdown", "code", "pdf", "image", "binary", "unknown"];

describe("rendererRegistry", () => {
  it("has an entry for every FileType", () => {
    for (const type of allTypes) {
      expect(rendererRegistry[type]).toBeDefined();
    }
  });

  it("every entry has valid contentSource", () => {
    for (const [_type, entry] of Object.entries(rendererRegistry)) {
      expect(["text", "raw"]).toContain(entry.contentSource);
    }
  });

  it("every entry has boolean feature flags", () => {
    for (const [_type, entry] of Object.entries(rendererRegistry)) {
      expect(typeof entry.features.toc).toBe("boolean");
      expect(typeof entry.features.raw).toBe("boolean");
      expect(typeof entry.features.headings).toBe("boolean");
      expect(typeof entry.features.copyable).toBe("boolean");
    }
  });

  it("markdown has toc, raw, headings, copyable enabled", () => {
    const md = rendererRegistry["markdown"];
    expect(md.features).toEqual({
      toc: true,
      raw: true,
      headings: true,
      copyable: true,
    });
    expect(md.contentSource).toBe("text");
  });

  it("pdf has all features disabled", () => {
    const pdf = rendererRegistry["pdf"];
    expect(pdf.features).toEqual({
      toc: false,
      raw: false,
      headings: false,
      copyable: false,
    });
    expect(pdf.contentSource).toBe("raw");
  });
});
