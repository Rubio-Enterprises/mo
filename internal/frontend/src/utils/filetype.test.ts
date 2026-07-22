import { describe, it, expect } from "vitest";
import { detectLanguage } from "./filetype";

describe("detectLanguage", () => {
  it("maps common extensions to languages", () => {
    expect(detectLanguage("main.go")).toBe("go");
    expect(detectLanguage("index.ts")).toBe("typescript");
    expect(detectLanguage("app.tsx")).toBe("tsx");
    expect(detectLanguage("style.css")).toBe("css");
    expect(detectLanguage("data.json")).toBe("json");
    expect(detectLanguage("config.yaml")).toBe("yaml");
    expect(detectLanguage("script.py")).toBe("python");
    expect(detectLanguage("lib.rs")).toBe("rust");
    expect(detectLanguage("run.sh")).toBe("bash");
  });

  it("handles special filenames", () => {
    expect(detectLanguage("Dockerfile")).toBe("dockerfile");
    expect(detectLanguage("Dockerfile.prod")).toBe("dockerfile");
    expect(detectLanguage("Makefile")).toBe("makefile");
  });

  it("returns text for unknown extensions", () => {
    expect(detectLanguage("file.xyz")).toBe("text");
    expect(detectLanguage("data.dat")).toBe("text");
  });

  it("handles paths with directories", () => {
    expect(detectLanguage("src/main.go")).toBe("go");
  });
});
