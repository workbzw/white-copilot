import fs from "fs/promises";
import path from "path";

const DATA_ROOT = path.join(process.cwd(), "data", "users");

export type DocMeta = {
  id: string;
  title: string;
  updatedAt: string;
};

/** body 为富文本 HTML，非 Markdown；referenceText 为重点引用资料全文；knowledgeDatasetIds 为本文档使用的知识库 id 列表 */
export type DocContent = DocMeta & {
  topic: string;
  outline: string[];
  body: string;
  referenceText?: string;
  knowledgeDatasetIds?: string[];
};

function userDir(userId: string): string {
  const safe = userId.replace(/[^a-zA-Z0-9_-]/g, "");
  if (!safe) throw new Error("invalid userId");
  return path.join(DATA_ROOT, safe);
}

function manifestPath(userId: string): string {
  return path.join(userDir(userId), "manifest.json");
}

function docPath(userId: string, docId: string): string {
  return path.join(userDir(userId), `${docId}.md`);
}

function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return { meta: {}, body: raw };
  const meta: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const m = line.match(/^(\w+):\s*(.*)$/);
    if (m) meta[m[1]] = m[2].replace(/^["']|["']$/g, "").trim();
  }
  return { meta, body: match[2] };
}

function stringifyFrontmatter(meta: Record<string, string | string[]>, body: string): string {
  const lines = ["---"];
  for (const [k, v] of Object.entries(meta)) {
    if (Array.isArray(v)) {
      lines.push(`${k}: ${JSON.stringify(v)}`);
    } else {
      const escaped = String(v).includes("\n") ? `"${String(v).replace(/"/g, '\\"')}"` : String(v);
      lines.push(`${k}: ${escaped}`);
    }
  }
  lines.push("---", "", body);
  return lines.join("\n");
}

export async function listDocs(userId: string): Promise<DocMeta[]> {
  const dir = userDir(userId);
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch {
    // ignore
  }
  const manifest = manifestPath(userId);
  try {
    const data = await fs.readFile(manifest, "utf-8");
    const list = JSON.parse(data) as DocMeta[];
    return Array.isArray(list) ? list.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || "")) : [];
  } catch {
    return [];
  }
}

export async function getDoc(userId: string, docId: string): Promise<DocContent | null> {
  const file = docPath(userId, docId);
  try {
    const raw = await fs.readFile(file, "utf-8");
    const { meta, body } = parseFrontmatter(raw);
    let outline: string[] = [];
    try {
      const o = meta.outline;
      outline = typeof o === "string" ? JSON.parse(o) : Array.isArray(o) ? o : [];
    } catch {
      // ignore
    }
    let referenceText = meta.referenceText ?? "";
    if (referenceText && (referenceText.startsWith("{") || referenceText.startsWith('"'))) {
      try {
        referenceText = JSON.parse(referenceText) as string;
      } catch {
        // 非 JSON 则保持原样（兼容旧数据）
      }
    }
    let knowledgeDatasetIds: string[] | undefined;
    try {
      const k = meta.knowledgeDatasetIds;
      if (Array.isArray(k)) knowledgeDatasetIds = k.filter((id): id is string => typeof id === "string");
      else if (typeof k === "string") knowledgeDatasetIds = JSON.parse(k) as string[];
    } catch {
      // ignore
    }
    return {
      id: docId,
      title: meta.title ?? "未命名",
      updatedAt: meta.updatedAt ?? "",
      topic: meta.topic ?? "",
      outline,
      body: body ?? "",
      referenceText: referenceText || undefined,
      knowledgeDatasetIds: knowledgeDatasetIds?.length ? knowledgeDatasetIds : undefined,
    };
  } catch {
    return null;
  }
}

export async function putDoc(
  userId: string,
  docId: string | null,
  payload: {
    title: string;
    topic: string;
    outline: string[];
    body: string;
    referenceText?: string;
    knowledgeDatasetIds?: string[];
  }
): Promise<DocMeta> {
  const dir = userDir(userId);
  await fs.mkdir(dir, { recursive: true });
  const id = docId ?? crypto.randomUUID();
  const updatedAt = new Date().toISOString();
  const metaForFile: Record<string, string | string[]> = {
    title: payload.title,
    topic: payload.topic,
    outline: payload.outline,
    updatedAt,
  };
  if (payload.referenceText != null && payload.referenceText !== "") {
    metaForFile.referenceText = JSON.stringify(payload.referenceText);
  }
  if (payload.knowledgeDatasetIds?.length) {
    metaForFile.knowledgeDatasetIds = payload.knowledgeDatasetIds;
  }
  const content = stringifyFrontmatter(metaForFile, payload.body);
  await fs.writeFile(path.join(dir, `${id}.md`), content, "utf-8");
  const meta: DocMeta = { id, title: payload.title, updatedAt };
  const manifest = manifestPath(userId);
  let list: DocMeta[] = [];
  try {
    const data = await fs.readFile(manifest, "utf-8");
    list = JSON.parse(data);
    if (!Array.isArray(list)) list = [];
  } catch {
    // new manifest
  }
  const idx = list.findIndex((d) => d.id === id);
  if (idx >= 0) {
    list[idx] = meta;
  } else {
    list.unshift(meta);
  }
  await fs.writeFile(manifest, JSON.stringify(list, null, 2), "utf-8");
  return meta;
}
