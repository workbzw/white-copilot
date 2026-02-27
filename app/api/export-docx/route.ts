import { NextRequest, NextResponse } from "next/server";
import HTMLtoDOCX from "html-to-docx";
import JSZip from "jszip";

const DOCX_FONT = "SimSun";

/** 判断一段 docx 段落 XML 是否为空（无实质文字） */
function isDocxParagraphEmpty(pXml: string): boolean {
  const tMatches = pXml.match(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g);
  if (!tMatches) return true;
  for (const m of tMatches) {
    const inner = m.replace(/<w:t[^>]*>|<\/w:t>/g, "");
    if (inner.replace(/\s/g, "").length > 0) return false;
  }
  return true;
}

/** 去掉 document.xml 里 body 开头的连续空段落，解决第一页空白 */
function removeLeadingEmptyParagraphs(documentXml: string): string {
  const bodyStart = documentXml.indexOf("<w:body");
  const bodyEnd = documentXml.indexOf("</w:body>");
  if (bodyStart === -1 || bodyEnd === -1) return documentXml;
  const bodyOpenEnd = documentXml.indexOf(">", bodyStart) + 1;
  let bodyContent = documentXml.slice(bodyOpenEnd, bodyEnd);
  const rest = documentXml.slice(bodyEnd);
  const beforeBody = documentXml.slice(0, bodyOpenEnd);

  const pTagRegex = /<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g;
  let stillLeading = true;
  bodyContent = bodyContent.replace(pTagRegex, (pBlock) => {
    if (!stillLeading) return pBlock;
    if (isDocxParagraphEmpty(pBlock)) return "";
    stillLeading = false;
    return pBlock;
  });
  return beforeBody + bodyContent + rest;
}

/** 把 docx 里所有字体改成宋体，并去掉第一页空段落 */
async function postProcessDocx(buffer: Buffer): Promise<Buffer> {
  const zip = await JSZip.loadAsync(buffer);
  for (const path of ["word/document.xml", "word/styles.xml"]) {
    const file = zip.file(path);
    if (!file) continue;
    let xml = await file.async("string");
    xml = xml
      .replace(/w:ascii="[^"]*"/g, `w:ascii="${DOCX_FONT}"`)
      .replace(/w:hAnsi="[^"]*"/g, `w:hAnsi="${DOCX_FONT}"`)
      .replace(/w:eastAsia="[^"]*"/g, `w:eastAsia="${DOCX_FONT}"`)
      .replace(/w:cs="[^"]*"/g, `w:cs="${DOCX_FONT}"`);
    if (path === "word/document.xml") xml = removeLeadingEmptyParagraphs(xml);
    zip.file(path, xml);
  }
  return Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
}

/** 去掉 HTML 开头连续的空段落/空行，避免 Word 第一页空白 */
function trimLeadingEmptyBlocks(html: string): string {
  let s = html.trim();
  // 去掉开头的空 p/div（含 &nbsp;、多个 br、空白）
  const emptyBlock =
    /^\s*<(p|div)(\s[^>]*)?>\s*(&nbsp;|<br\s*\/?>|\s)*<\/\1>\s*/gi;
  let prev = "";
  while (prev !== s) {
    prev = s;
    s = s.replace(emptyBlock, "").trim();
  }
  return s;
}

const SONG_FONT = "宋体, SimSun, 'Songti SC', serif";

/** 把 HTML 里所有内联的 font-family 统一成宋体，避免导出 Word 变成 Arial 等 */
function forceSongFontInHtml(html: string): string {
  return html.replace(
    /font-family\s*:\s*[^;]+;?/gi,
    `font-family: ${SONG_FONT}; `
  );
}

/** POST body: { html: string }. 返回 docx 文件流（富文本 HTML 转 Word） */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    let html = typeof body.html === "string" ? body.html : "";
    if (!html.trim()) {
      return NextResponse.json({ error: "缺少 html 内容" }, { status: 400 });
    }
    html = trimLeadingEmptyBlocks(html);
    if (!html) {
      return NextResponse.json({ error: "缺少 html 内容" }, { status: 400 });
    }
    html = forceSongFontInHtml(html);
    if (!html.includes("<html")) {
      // 用带宋体样式的容器包裹，确保导出 Word 全文为宋体（库的 font 选项对部分软件不生效）
      html = `<!DOCTYPE html><html><head><meta charset="UTF-8"/><style>body, body * { font-family: ${SONG_FONT} !important; }</style></head><body><div style="font-family: ${SONG_FONT}">${html}</div></body></html>`;
    }
    let buffer = await HTMLtoDOCX(html, null, {
      font: "SimSun",
      fontSize: 24,
      complexScriptFontSize: 24,
      table: { row: { cantSplit: true } },
    });
    buffer = await postProcessDocx(Buffer.from(buffer));
    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "Content-Disposition": `attachment; filename="document.docx"`,
      },
    });
  } catch (e) {
    console.error("[export-docx]", e);
    return NextResponse.json(
      { error: "导出 Word 失败" },
      { status: 500 }
    );
  }
}
