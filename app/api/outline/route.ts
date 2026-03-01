import { NextRequest, NextResponse } from "next/server";
import { generateReportOutline } from "@/lib/siliconflow";
import { extractReferenceText } from "@/lib/file-extract";

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const topic = (formData.get("topic") as string)?.trim() || "";
    const coreContent = (formData.get("coreContent") as string)?.trim() || "";
    const styleMode = (formData.get("styleMode") as string) || "ai";
    const files = (formData.getAll("files") as File[]).filter(Boolean);

    if (!topic) {
      return NextResponse.json(
        { error: "报告主题不能为空" },
        { status: 400 }
      );
    }

    const { referenceText, errors: extractErrors } = await extractReferenceText(files);
    if (extractErrors.length) {
      console.log("[outline] 引用资料提取提示:", extractErrors);
    }
    console.log("[outline] 请求参数:", { topic, coreContent, styleMode, filesCount: files.length, referenceLen: referenceText.length });

    const outline = await generateReportOutline({
      topic,
      coreContent: coreContent || undefined,
      styleMode: styleMode === "standard" ? "standard" : "ai",
      referenceText: referenceText || undefined,
    });

    console.log("[outline] 生成结果:", outline);
    return NextResponse.json({ outline, referenceText: referenceText || "" });
  } catch (e) {
    const message = e instanceof Error ? e.message : "生成大纲失败，请稍后重试";
    const isConfigError = message.includes("API Key") || message.includes("LLM_API_KEY");
    const status = (e as { status?: number })?.status;
    const is401 = status === 401 || message.includes("401");

    if (isConfigError) {
      return NextResponse.json(
        { error: "未配置大模型 API Key，请在 .env 中设置 LLM_API_KEY（或 SILICONFLOW_API_KEY）" },
        { status: 503 }
      );
    }
    if (is401) {
      return NextResponse.json(
        { error: "大模型 API 鉴权失败（401），请检查 .env 中的 LLM_API_KEY 是否正确、是否已过期" },
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
