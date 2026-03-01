import { NextRequest, NextResponse } from "next/server";
import { retrieveFromKnowledge } from "@/lib/knowledge-retrieve";

/**
 * 验证知识库检索是否可用。
 * GET /api/knowledge-retrieve-test?query=测试
 * 或 POST /api/knowledge-retrieve-test body: { "query": "测试" }
 * 返回：{ success, recordCount, totalChars, preview?, error? }
 */
export async function GET(request: NextRequest) {
  const query = request.nextUrl.searchParams.get("query")?.trim() || "测试";
  return runTest(query);
}

export async function POST(request: NextRequest) {
  let query = "测试";
  try {
    const body = await request.json().catch(() => ({}));
    if (typeof body.query === "string" && body.query.trim()) query = body.query.trim();
  } catch {
    // keep default
  }
  return runTest(query);
}

async function runTest(query: string) {
  const hasConfig =
    !!process.env.KNOWLEDGE_API_KEY?.trim() &&
    (!!process.env.KNOWLEDGE_DATASET_ID?.trim() || !!process.env.KNOWLEDGE_DATASET_IDS?.trim());
  if (!hasConfig) {
    return NextResponse.json({
      success: false,
      error: "未配置 KNOWLEDGE_API_KEY 或 KNOWLEDGE_DATASET_ID / KNOWLEDGE_DATASET_IDS",
      recordCount: 0,
      totalChars: 0,
    });
  }

  const text = await retrieveFromKnowledge(query, { topK: 5 });
  const recordCount = text ? text.split("\n\n---\n\n").length : 0;
  const totalChars = text.length;
  const preview = text ? text.slice(0, 300) + (text.length > 300 ? "…" : "") : "";

  return NextResponse.json({
    success: true,
    query,
    recordCount,
    totalChars,
    preview: preview || undefined,
  });
}
