/**
 * 从上传文件中提取纯文本，供 AI 引用。
 * 支持 .txt、.doc、.docx；总长度限制避免超出上下文。（不解析 PDF）
 */

const MAX_REFERENCE_CHARS = 8000;
const ALLOWED_EXT = new Set([".txt", ".doc", ".docx"]);
const MAX_FILE_SIZE_BYTES = 2 * 1024 * 1024; // 2MB per file
const MAX_FILES = 5;

function getExt(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i).toLowerCase() : "";
}

export async function extractTextFromFile(
  file: File
): Promise<{ text: string; error?: string }> {
  const ext = getExt(file.name);
  if (!ALLOWED_EXT.has(ext)) {
    return { text: "", error: `不支持的文件类型: ${ext}` };
  }
  if (file.size > MAX_FILE_SIZE_BYTES) {
    return { text: "", error: `文件过大: ${file.name}` };
  }
  const buf = Buffer.from(await file.arrayBuffer());
  if (ext === ".txt") {
    const text = buf.toString("utf-8").trim();
    return { text };
  }
  if (ext === ".docx" || ext === ".doc") {
    try {
      const mammoth = await import("mammoth");
      const result = await mammoth.extractRawText({ buffer: buf });
      const text = (result?.value ?? "").trim();
      return { text };
    } catch (e) {
      return { text: "", error: `Word 解析失败: ${file.name}` };
    }
  }
  return { text: "" };
}

/**
 * 从多个文件中提取文本并拼接，总长度不超过 MAX_REFERENCE_CHARS。
 * 返回 { referenceText, errors }，errors 为解析失败或跳过的提示。
 */
export async function extractReferenceText(files: File[]): Promise<{
  referenceText: string;
  errors: string[];
}> {
  const errors: string[] = [];
  if (!files?.length) return { referenceText: "", errors: [] };
  const toProcess = files.slice(0, MAX_FILES);
  if (files.length > MAX_FILES) {
    errors.push(`最多处理 ${MAX_FILES} 个文件，已忽略多余文件。`);
  }
  const parts: string[] = [];
  let totalLen = 0;
  for (const file of toProcess) {
    const { text, error } = await extractTextFromFile(file);
    if (error) {
      errors.push(error);
      continue;
    }
    if (!text) continue;
    const take = Math.min(
      text.length,
      MAX_REFERENCE_CHARS - totalLen
    );
    if (take <= 0) {
      errors.push(`已达引用资料长度上限，已截断: ${file.name}`);
      break;
    }
    parts.push(text.slice(0, take));
    totalLen += take;
    if (totalLen >= MAX_REFERENCE_CHARS) break;
  }
  const referenceText = parts.join("\n\n---\n\n").trim();
  return { referenceText, errors };
}
