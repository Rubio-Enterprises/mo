export type FileType = "markdown" | "code" | "pdf" | "image" | "binary" | "unknown";

export interface FileEntry {
  name: string;
  id: string;
  path: string;
  title?: string;
  uploaded?: boolean;
  type: FileType;
}

export interface Group {
  name: string;
  files: FileEntry[];
}

export interface FileContent {
  content: string;
  baseDir: string;
}

export interface VersionInfo {
  version: string;
  revision: string;
}

export async function fetchGroups(): Promise<Group[]> {
  const res = await fetch("/_/api/groups");
  if (!res.ok) throw new Error("Failed to fetch groups");
  return res.json();
}

export async function fetchFileContent(id: string): Promise<FileContent> {
  const res = await fetch(`/_/api/files/${id}/content`);
  if (!res.ok) throw new Error("Failed to fetch file content");
  return res.json();
}

export async function openRelativeFile(fileId: string, relativePath: string): Promise<FileEntry> {
  const res = await fetch("/_/api/files/open", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fileId, path: relativePath }),
  });
  if (!res.ok) throw new Error("Failed to open file");
  return res.json();
}

export async function removeFile(id: string): Promise<void> {
  const res = await fetch(`/_/api/files/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error("Failed to remove file");
}

export async function reorderFiles(groupName: string, fileIds: string[]): Promise<void> {
  const res = await fetch("/_/api/reorder", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ group: groupName, fileIds }),
  });
  if (!res.ok) throw new Error("Failed to reorder files");
}

export async function moveFile(id: string, group: string): Promise<void> {
  const res = await fetch(`/_/api/files/${id}/group`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ group }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text.trim() || "Failed to move file");
  }
}

export async function uploadFile(name: string, content: string, group: string): Promise<void> {
  const res = await fetch("/_/api/files/upload", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, content, group }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text.trim() || "Failed to upload file");
  }
}

export async function restartServer(): Promise<void> {
  const res = await fetch("/_/api/restart", { method: "POST" });
  if (!res.ok) throw new Error("Failed to restart server");
}

export async function fetchVersion(): Promise<VersionInfo> {
  const res = await fetch("/_/api/version");
  if (!res.ok) throw new Error("Failed to fetch version");
  return res.json();
}

export function rawFileUrl(id: string, revision?: number): string {
  const base = `/_/api/files/${id}/raw`;
  return revision != null ? `${base}?v=${revision}` : base;
}

export interface CheckboxState {
  sources: Record<string, boolean>;
  overrides: Record<string, boolean>;
  orderedKeys: string[];
}

export async function fetchCheckboxes(id: string): Promise<CheckboxState> {
  const res = await fetch(`/_/api/files/${id}/checkboxes`);
  if (!res.ok) throw new Error("Failed to fetch checkboxes");
  return res.json();
}

export async function toggleCheckbox(id: string, key: string, checked: boolean): Promise<void> {
  const res = await fetch(`/_/api/files/${id}/checkboxes/${encodeURIComponent(key)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ checked }),
  });
  if (!res.ok) throw new Error("Failed to toggle checkbox");
}

export async function uncheckAllCheckboxes(id: string): Promise<void> {
  const res = await fetch(`/_/api/files/${id}/checkboxes`, { method: "DELETE" });
  if (!res.ok) throw new Error("Failed to uncheck all");
}

export async function checkAllCheckboxes(id: string): Promise<void> {
  const res = await fetch(`/_/api/files/${id}/checkboxes/check-all`, { method: "POST" });
  if (!res.ok) throw new Error("Failed to check all");
}
