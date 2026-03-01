import { NextRequest, NextResponse } from "next/server";
import { listDocs, putDoc } from "@/lib/docs-storage";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ userId: string }> }
) {
  try {
    const { userId } = await params;
    if (!userId) {
      return NextResponse.json({ error: "缺少 userId" }, { status: 400 });
    }
    const docs = await listDocs(userId);
    return NextResponse.json({ docs });
  } catch (e) {
    console.error("[docs list]", e);
    return NextResponse.json({ error: "获取文档列表失败" }, { status: 500 });
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ userId: string }> }
) {
  try {
    const { userId } = await params;
    if (!userId) {
      return NextResponse.json({ error: "缺少 userId" }, { status: 400 });
    }
    const body = await request.json();
    const title = (body.title as string)?.trim() || "未命名文档";
    const topic = (body.topic as string)?.trim() || "";
    const outline = Array.isArray(body.outline) ? body.outline : [];
    const docBody = (body.body as string) ?? "";
    const referenceText = typeof body.referenceText === "string" ? body.referenceText : undefined;
    const knowledgeDatasetIds = Array.isArray(body.knowledgeDatasetIds)
      ? (body.knowledgeDatasetIds as unknown[]).filter((id): id is string => typeof id === "string").filter(Boolean)
      : undefined;
    const meta = await putDoc(userId, null, {
      title,
      topic,
      outline,
      body: docBody,
      referenceText,
      knowledgeDatasetIds: knowledgeDatasetIds?.length ? knowledgeDatasetIds : undefined,
    });
    return NextResponse.json(meta);
  } catch (e) {
    console.error("[docs create]", e);
    return NextResponse.json({ error: "创建文档失败" }, { status: 500 });
  }
}
