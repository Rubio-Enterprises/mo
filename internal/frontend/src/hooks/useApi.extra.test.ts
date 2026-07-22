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
  it("sends DELETE to the encoded group-scoped URL", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    await removeFile("api/docs", "abc12345");
    expect(fetch).toHaveBeenCalledWith("/_/api/groups/api%2Fdocs/files/abc12345", {
      method: "DELETE",
    });
  });

  it("throws on non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    await expect(removeFile("default", "abc")).rejects.toThrow("Failed to remove file");
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
  it("returns an encoded group-scoped URL when no revision is given", () => {
    expect(rawFileUrl("api/docs", "abc")).toBe("/_/api/groups/api%2Fdocs/files/abc/raw");
  });

  it("appends revision when provided", () => {
    expect(rawFileUrl("default", "abc", 7)).toBe("/_/api/groups/default/files/abc/raw?v=7");
  });

  it("appends revision=0", () => {
    expect(rawFileUrl("default", "abc", 0)).toBe("/_/api/groups/default/files/abc/raw?v=0");
  });
});

describe("checkbox APIs", () => {
  it("fetchCheckboxes returns parsed state from an encoded group URL", async () => {
    const data = { sources: { a: true }, overrides: {}, orderedKeys: ["a"] };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(data),
      }),
    );
    const res = await fetchCheckboxes("api/docs", "file-id");
    expect(res).toEqual(data);
    expect(fetch).toHaveBeenCalledWith("/_/api/groups/api%2Fdocs/files/file-id/checkboxes");
  });

  it("fetchCheckboxes throws on error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    await expect(fetchCheckboxes("default", "f")).rejects.toThrow("Failed to fetch checkboxes");
  });

  it("toggleCheckbox encodes group and key and sends PUT", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    await toggleCheckbox("api/docs", "f", "my key/with-slash", true);
    expect(fetch).toHaveBeenCalledWith(
      `/_/api/groups/api%2Fdocs/files/f/checkboxes/${encodeURIComponent("my key/with-slash")}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ checked: true }),
      },
    );
  });

  it("toggleCheckbox throws on error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    await expect(toggleCheckbox("default", "f", "k", false)).rejects.toThrow(
      "Failed to toggle checkbox",
    );
  });

  it("uncheckAllCheckboxes sends DELETE", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    await uncheckAllCheckboxes("default", "f");
    expect(fetch).toHaveBeenCalledWith("/_/api/groups/default/files/f/checkboxes", {
      method: "DELETE",
    });
  });

  it("uncheckAllCheckboxes throws on error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    await expect(uncheckAllCheckboxes("default", "f")).rejects.toThrow("Failed to uncheck all");
  });

  it("checkAllCheckboxes sends POST to check-all", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    await checkAllCheckboxes("default", "f");
    expect(fetch).toHaveBeenCalledWith("/_/api/groups/default/files/f/checkboxes/check-all", {
      method: "POST",
    });
  });

  it("checkAllCheckboxes throws on error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    await expect(checkAllCheckboxes("default", "f")).rejects.toThrow("Failed to check all");
  });
});
