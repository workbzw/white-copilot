import { NextRequest, NextResponse } from "next/server";
import { getDoc, putDoc } from "@/lib/docs-storage";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ userId: string; docId: string }> }
) {
  try {
    const { userId, docId } = await params;
    if (!userId || !docId) {
      return NextResponse.json({ error: "缺少 userId 或 docId" }, { status: 400 });
    }
    const doc = await getDoc(userId, docId);
    if (!doc) {
      return NextResponse.json({ error: "文档不存在" }, { status: 404 });
    }
    return NextResponse.json(doc);
  } catch (e) {
    console.error("[doc get]", e);
    return NextResponse.json({ error: "获取文档失败" }, { status: 500 });
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ userId: string; docId: string }> }
) {
  try {
    const { userId, docId } = await params;
    if (!userId || !docId) {
      return NextResponse.json({ error: "缺少 userId 或 docId" }, { status: 400 });
    }
    const body = await request.json();
    const title = (body.title as string)?.trim() || "未命名文档";
    const topic = (body.topic as string)?.trim() || "";
    const outline = Array.isArray(body.outline) ? body.outline : [];
    const docBody = (body.body as string) ?? "";
    const referenceText = typeof body.referenceText === "string" ? body.referenceText : undefined;
    const meta = await putDoc(userId, docId, { title, topic, outline, body: docBody, referenceText });
    return NextResponse.json(meta);
  } catch (e) {
    console.error("[doc update]", e);
    return NextResponse.json({ error: "更新文档失败" }, { status: 500 });
  }
}
