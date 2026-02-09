import { NextRequest, NextResponse } from "next/server";
import { generateReportOutline } from "@/lib/siliconflow";

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const topic = (formData.get("topic") as string)?.trim() || "";
    const coreContent = (formData.get("coreContent") as string)?.trim() || "";
    const styleMode = (formData.get("styleMode") as string) || "ai";
    const files = formData.getAll("files") as File[];

    if (!topic) {
      return NextResponse.json(
        { error: "报告主题不能为空" },
        { status: 400 }
      );
    }

    console.log("[outline] 请求参数:", { topic, coreContent, styleMode, filesCount: files.length });

    const outline = await generateReportOutline({
      topic,
      coreContent: coreContent || undefined,
      styleMode: styleMode === "standard" ? "standard" : "ai",
    });

    console.log("[outline] 生成结果:", outline);
    return NextResponse.json({ outline });
  } catch (e) {
    const message = e instanceof Error ? e.message : "生成大纲失败，请稍后重试";
    const isConfigError = message.includes("SILICONFLOW_API_KEY");

    if (isConfigError) {
      return NextResponse.json(
        { error: "未配置硅基流动 API Key，请在 .env 中设置 SILICONFLOW_API_KEY" },
        { status: 503 }
      );
    }

    console.error("outline API error:", e);
    return NextResponse.json(
      { error: message },
      { status: 500 }
    );
  }
}
