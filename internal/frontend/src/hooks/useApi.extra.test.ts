import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  removeFile,
  restartServer,
  fetchVersion,
  rawFileUrl,
  fetchCheckboxes,
  toggleCheckbox,
  uncheckAllCheckboxes,
  checkAllCheckboxes,
} from "./useApi";

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("removeFile", () => {
  it("sends DELETE with the right URL", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    await removeFile("abc12345");
    expect(fetch).toHaveBeenCalledWith("/_/api/files/abc12345", { method: "DELETE" });
  });

  it("throws on non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    await expect(removeFile("abc")).rejects.toThrow("Failed to remove file");
  });
});

describe("restartServer", () => {
  it("posts to /_/api/restart", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    await restartServer();
    expect(fetch).toHaveBeenCalledWith("/_/api/restart", { method: "POST" });
  });

  it("throws on non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    await expect(restartServer()).rejects.toThrow("Failed to restart server");
  });
});

describe("fetchVersion", () => {
  it("returns version info on success", async () => {
    const data = { version: "v1.0", revision: "abc" };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(data),
      }),
    );
    const res = await fetchVersion();
    expect(res).toEqual(data);
    expect(fetch).toHaveBeenCalledWith("/_/api/version");
  });

  it("throws on non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    await expect(fetchVersion()).rejects.toThrow("Failed to fetch version");
  });
});

describe("rawFileUrl", () => {
  it("returns base URL when no revision is given", () => {
    expect(rawFileUrl("abc")).toBe("/_/api/files/abc/raw");
  });

  it("appends revision when provided", () => {
    expect(rawFileUrl("abc", 7)).toBe("/_/api/files/abc/raw?v=7");
  });

  it("appends revision=0", () => {
    expect(rawFileUrl("abc", 0)).toBe("/_/api/files/abc/raw?v=0");
  });
});

describe("checkbox APIs", () => {
  it("fetchCheckboxes returns parsed state", async () => {
    const data = { sources: { a: true }, overrides: {}, orderedKeys: ["a"] };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(data),
      }),
    );
    const res = await fetchCheckboxes("file-id");
    expect(res).toEqual(data);
    expect(fetch).toHaveBeenCalledWith("/_/api/files/file-id/checkboxes");
  });

  it("fetchCheckboxes throws on error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    await expect(fetchCheckboxes("f")).rejects.toThrow("Failed to fetch checkboxes");
  });

  it("toggleCheckbox encodes key and sends PUT", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    await toggleCheckbox("f", "my key/with-slash", true);
    expect(fetch).toHaveBeenCalledWith(
      `/_/api/files/f/checkboxes/${encodeURIComponent("my key/with-slash")}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ checked: true }),
      },
    );
  });

  it("toggleCheckbox throws on error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    await expect(toggleCheckbox("f", "k", false)).rejects.toThrow("Failed to toggle checkbox");
  });

  it("uncheckAllCheckboxes sends DELETE", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    await uncheckAllCheckboxes("f");
    expect(fetch).toHaveBeenCalledWith("/_/api/files/f/checkboxes", { method: "DELETE" });
  });

  it("uncheckAllCheckboxes throws on error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    await expect(uncheckAllCheckboxes("f")).rejects.toThrow("Failed to uncheck all");
  });

  it("checkAllCheckboxes sends POST to check-all", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    await checkAllCheckboxes("f");
    expect(fetch).toHaveBeenCalledWith("/_/api/files/f/checkboxes/check-all", { method: "POST" });
  });

  it("checkAllCheckboxes throws on error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    await expect(checkAllCheckboxes("f")).rejects.toThrow("Failed to check all");
  });
});
