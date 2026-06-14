/**
 * E2E tests against the mo HTTP API.
 *
 * These tests verify the contract that the CLI and frontend rely on:
 *   - status / groups
 *   - add / remove / reorder files
 *   - SSE event broadcasting
 *   - shutdown
 */

import { test, expect, testdata } from "./fixtures";

test.describe("mo HTTP API", () => {
  test("GET /_/api/status returns version, pid, and groups", async ({ moServer, request }) => {
    const res = await request.get(`${moServer.baseURL}/_/api/status`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.version).toBeTruthy();
    expect(typeof body.pid).toBe("number");
    expect(Array.isArray(body.groups)).toBe(true);
    expect(body.groups.length).toBeGreaterThan(0);
    // The default group should contain the initial file from the fixture.
    const def = body.groups.find((g: { name: string }) => g.name === "default");
    expect(def).toBeTruthy();
    expect(def.files.length).toBeGreaterThanOrEqual(1);
  });

  test("GET /_/api/groups returns groups with file entries", async ({ moServer, request }) => {
    const res = await request.get(`${moServer.baseURL}/_/api/groups`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    const file = body[0].files[0];
    expect(file.id).toMatch(/^[a-f0-9]{8}$/);
    expect(file.path).toBeTruthy();
    expect(file.type).toBe("markdown");
  });

  test("POST /_/api/files adds a file to the default group", async ({ moServer, request }) => {
    const target = testdata("basic.md");
    const res = await request.post(`${moServer.baseURL}/_/api/files`, {
      data: { path: target, group: "default" },
    });
    expect(res.status()).toBe(200);
    const entry = await res.json();
    expect(entry.id).toMatch(/^[a-f0-9]{8}$/);
    expect(entry.path).toBe(target);
  });

  test("POST /_/api/files accepts a custom group and creates it", async ({
    moServer,
    request,
  }) => {
    await moServer.addFile(testdata("lists.md"), "docs");

    const groups = await (await request.get(`${moServer.baseURL}/_/api/groups`)).json();
    const docs = groups.find((g: { name: string }) => g.name === "docs");
    expect(docs).toBeTruthy();
    expect(docs.files.length).toBe(1);
  });

  test("DELETE /_/api/files/{id} removes the file", async ({ moServer, request }) => {
    const added = await moServer.addFile(testdata("gfm.md"));
    const del = await request.delete(`${moServer.baseURL}/_/api/files/${added.id}`);
    expect(del.status()).toBe(204);

    const groups = await (await request.get(`${moServer.baseURL}/_/api/groups`)).json();
    const def = groups.find((g: { name: string }) => g.name === "default");
    expect(def.files.some((f: { id: string }) => f.id === added.id)).toBe(false);
  });

  test("GET /_/api/files/{id}/content returns the file body", async ({
    moServer,
    request,
  }) => {
    const added = await moServer.addFile(testdata("basic.md"));
    const res = await request.get(`${moServer.baseURL}/_/api/files/${added.id}/content`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.content).toContain("# Basic Markdown");
    expect(typeof body.baseDir).toBe("string");
  });

  test("GET /_/api/files/{id}/raw returns raw bytes", async ({ moServer, request }) => {
    const added = await moServer.addFile(testdata("basic.md"));
    const res = await request.get(`${moServer.baseURL}/_/api/files/${added.id}/raw`);
    expect(res.status()).toBe(200);
    const text = await res.text();
    expect(text).toContain("# Basic Markdown");
  });

  test("PUT /_/api/reorder swaps order in a group", async ({ moServer, request }) => {
    const a = await moServer.addFile(testdata("basic.md"));
    const b = await moServer.addFile(testdata("gfm.md"));

    // Reorder requires ALL file IDs in the group; fetch the current list first.
    const groupsBefore = await (await request.get(`${moServer.baseURL}/_/api/groups`)).json();
    const defBefore = groupsBefore.find((g: { name: string }) => g.name === "default");
    const currentIds: string[] = defBefore.files.map((f: { id: string }) => f.id);
    // Move b before a but keep all other ids intact.
    const reordered = [...currentIds.filter((id) => id !== a.id && id !== b.id), b.id, a.id];

    const reorderRes = await request.put(`${moServer.baseURL}/_/api/reorder`, {
      data: { group: "default", fileIds: reordered },
    });
    expect(reorderRes.ok()).toBe(true);

    const groups = await (await request.get(`${moServer.baseURL}/_/api/groups`)).json();
    const def = groups.find((g: { name: string }) => g.name === "default");
    const ids = def.files.map((f: { id: string }) => f.id);
    expect(ids.indexOf(b.id)).toBeLessThan(ids.indexOf(a.id));
  });

  test("PUT /_/api/files/{id}/group moves a file between groups", async ({
    moServer,
    request,
  }) => {
    const added = await moServer.addFile(testdata("basic.md"));
    const res = await request.put(`${moServer.baseURL}/_/api/files/${added.id}/group`, {
      data: { group: "docs" },
    });
    expect(res.ok()).toBe(true);

    const groups = await (await request.get(`${moServer.baseURL}/_/api/groups`)).json();
    const def = groups.find((g: { name: string }) => g.name === "default");
    const docs = groups.find((g: { name: string }) => g.name === "docs");
    expect(def?.files.some((f: { id: string }) => f.id === added.id) ?? false).toBe(false);
    expect(docs?.files.some((f: { id: string }) => f.id === added.id)).toBe(true);
  });

  test("invalid file path returns 404", async ({ moServer, request }) => {
    const res = await request.get(`${moServer.baseURL}/_/api/files/00000000/content`);
    expect(res.status()).toBe(404);
  });

  test("POST /_/api/files with a non-existent path returns 4xx", async ({
    moServer,
    request,
  }) => {
    // handleAddFile in internal/server/server.go calls os.Stat on the resolved
    // absolute path and returns 400 "file not found" when the path does not
    // exist. This is a deterministic invalid-request case (unlike an empty
    // body, which resolves to the server's CWD and happens to be a directory).
    const res = await request.post(`${moServer.baseURL}/_/api/files`, {
      data: {
        path: "/__nonexistent_path_for_e2e__/missing.md",
        group: "default",
      },
    });
    expect(res.status()).toBeGreaterThanOrEqual(400);
    expect(res.status()).toBeLessThan(500);
  });

  test("GET /_/events emits an update event when a file is added", async ({ moServer }) => {
    // Open the SSE stream first, then add a file, and verify the
    // 'update' event arrives within a few seconds.
    const events: string[] = [];
    const controller = new AbortController();

    const streamPromise = (async () => {
      const res = await fetch(`${moServer.baseURL}/_/events`, {
        signal: controller.signal,
        headers: moServer.token ? { "X-Mo-Token": moServer.token } : {},
      });
      if (!res.body) throw new Error("no SSE body");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await reader.read();
        } catch {
          return;
        }
        if (chunk.done) return;
        buffer += decoder.decode(chunk.value, { stream: true });
        // SSE events are separated by blank lines.
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";
        for (const part of parts) {
          const match = part.match(/^event:\s*(\S+)/m);
          if (match) events.push(match[1]);
        }
        if (events.includes("update")) return;
      }
    })();

    // Give the server a tick to register the subscriber before triggering.
    await new Promise((r) => setTimeout(r, 100));
    await moServer.addFile(testdata("basic.md"));

    // Wait for the stream to see the event, or time out.
    const timeout = new Promise<void>((_, rej) =>
      setTimeout(() => rej(new Error("SSE timeout")), 5_000),
    );
    try {
      await Promise.race([streamPromise, timeout]);
    } finally {
      controller.abort();
    }

    expect(events).toContain("update");
  });
});
