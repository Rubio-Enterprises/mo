import { describe, it, expect } from "vitest";
import { rehypeCheckboxIndices } from "./rehypeCheckboxIndices";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import rehypeRaw from "rehype-raw";
import rehypeStringify from "rehype-stringify";

async function processMarkdown(md: string, orderedKeys: string[]) {
  const result = await unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeRaw)
    .use(rehypeCheckboxIndices, { orderedKeys })
    .use(rehypeStringify)
    .process(md);
  return String(result);
}

describe("rehypeCheckboxIndices plugin", () => {
  it("assigns keys in document order", async () => {
    const md = "- [ ] First item\n- [x] Second item\n";
    const html = await processMarkdown(md, ["First item", "Second item"]);
    expect(html).toContain('data-checkbox-key="First item"');
    expect(html).toContain('data-checkbox-key="Second item"');
    const firstIdx = html.indexOf('data-checkbox-key="First item"');
    const secondIdx = html.indexOf('data-checkbox-key="Second item"');
    expect(firstIdx).toBeGreaterThan(-1);
    expect(secondIdx).toBeGreaterThan(firstIdx);
  });

  it("assigns disambiguated keys by index (ignoring text content)", async () => {
    const md = "- [ ] TODO\n- [ ] TODO\n- [x] TODO\n";
    const html = await processMarkdown(md, ["TODO", "TODO#2", "TODO#3"]);
    expect(html).toContain('data-checkbox-key="TODO"');
    expect(html).toContain('data-checkbox-key="TODO#2"');
    expect(html).toContain('data-checkbox-key="TODO#3"');
  });

  it("leaves excess checkboxes unkeyed when fewer keys than checkboxes", async () => {
    const md = "- [ ] One\n- [ ] Two\n- [ ] Three\n";
    const html = await processMarkdown(md, ["One", "Two"]);
    expect(html).toContain('data-checkbox-key="One"');
    expect(html).toContain('data-checkbox-key="Two"');
    const matches = html.match(/data-checkbox-key=/g) ?? [];
    expect(matches.length).toBe(2);
  });

  it("ignores excess keys when more keys than checkboxes", async () => {
    const md = "- [ ] Only\n";
    const html = await processMarkdown(md, ["Only", "Extra", "Phantom"]);
    expect(html).toContain('data-checkbox-key="Only"');
    expect(html).not.toContain('data-checkbox-key="Extra"');
    expect(html).not.toContain('data-checkbox-key="Phantom"');
  });

  it("ignores non-checkbox inputs", async () => {
    const md = 'Some text <input type="text" /> more text\n';
    const html = await processMarkdown(md, ["Only"]);
    expect(html).not.toContain("data-checkbox-key");
  });

  it("ignores raw HTML checkboxes outside a task-list-item", async () => {
    const md = '<input type="checkbox"> raw html\n\n- [ ] Real task\n';
    const html = await processMarkdown(md, ["Real task"]);
    expect(html).toContain('data-checkbox-key="Real task"');
    const matches = html.match(/data-checkbox-key=/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it("handles checkboxes in loose lists (wrapped in <p>)", async () => {
    const md = "- [ ] Task A\n\n  More details\n\n- [ ] Task B\n";
    const html = await processMarkdown(md, ["Task A", "Task B"]);
    expect(html).toContain('data-checkbox-key="Task A"');
    expect(html).toContain('data-checkbox-key="Task B"');
  });

  it("preserves existing data-* attributes on inputs", async () => {
    const md = "- [ ] Task\n";
    const html = await processMarkdown(md, ["Task"]);
    expect(html).toMatch(/<input[^>]*type="checkbox"[^>]*data-checkbox-key="Task"/);
  });

  it("does not attach keys when orderedKeys is empty", async () => {
    const md = "- [ ] First\n- [ ] Second\n";
    const html = await processMarkdown(md, []);
    expect(html).not.toContain("data-checkbox-key");
  });
});
