import { NextRequest } from "next/server";
import { getSiliconFlowChatModel } from "@/lib/siliconflow";
import { retrieveFromKnowledge } from "@/lib/knowledge-retrieve";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";

export const maxDuration = 120;

export async function POST(request: NextRequest) {
  try {
    let body: Record<string, unknown>;
    try {
      const raw = await request.text();
      if (!raw?.trim()) {
        return new Response(
          JSON.stringify({ error: "请求体为空" }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }
      body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return new Response(
        JSON.stringify({ error: "请求体不是有效 JSON" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }
    const outline = body.outline as string[] | undefined;
    const topic = (body.topic as string)?.trim() || "";
    const wordCount = String(body.wordCount || "3000").trim() || "3000";
    const reportTemplate = (body.reportTemplate as string)?.trim() || "公告模板";
    const coreContent = (body.coreContent as string)?.trim() || "";
    const styleMode = body.styleMode === "standard" ? "standard" : "ai";
    const referenceText = (body.referenceText as string)?.trim() || "";
    const rawIds = body.knowledgeDatasetIds;
    const knowledgeDatasetIds: string[] = Array.isArray(rawIds)
      ? (rawIds as unknown[]).filter((id): id is string => typeof id === "string").map((id) => id.trim()).filter(Boolean)
      : typeof rawIds === "string"
        ? rawIds.split(",").map((s) => s.trim()).filter(Boolean)
        : [];

    if (!outline?.length || !topic) {
      return new Response(
        JSON.stringify({ error: "缺少报告主题或大纲" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // 按用户目标字数：预留足够 token（中文约 1～2 字/token），避免因 token 上限被截断
    const requestedWords = Math.max(100, parseInt(wordCount, 10) || 3000);
    const maxTokens = Math.min(32768, Math.max(256, Math.ceil(requestedWords * 2)));

    const llm = getSiliconFlowChatModel({
      temperature: 0.6,
      maxTokens,
    });

    let knowledgeText = "";
    if (process.env.KNOWLEDGE_API_KEY?.trim() && knowledgeDatasetIds.length > 0) {
      try {
        knowledgeText = await retrieveFromKnowledge(topic, {
          topK: 5,
          datasetIds: knowledgeDatasetIds,
        });
      } catch (e) {
        console.warn("[body] 知识库检索失败，继续生成正文", e);
      }
    }
    const hasLocalRef = !!referenceText?.trim();
    const hasKnowledge = !!knowledgeText?.trim();

    const outlineText = outline.map((item, i) => `${i + 1}. ${item}`).join("\n");
    const styleHint =
      styleMode === "standard"
        ? "请严格按标准公文格式与用语撰写，层次清晰、用语规范。"
        : "可适当发挥，保持专业、条理清晰。";

    const refRule =
      hasLocalRef && hasKnowledge
        ? "若同时提供了本地引用文章与知识库检索结果，则重点引用本地文章，适当引用知识库作为补充。"
        : "若用户提供了重点引用资料，正文中必须引用其中的关键数据、表述或观点，应明确体现资料内容，不得完全脱离资料发挥。";

    const systemPrompt = `你是一名专业报告撰写助手。请根据用户提供的大纲和主题，撰写完整报告正文。
${styleHint}
要求：
1. 按给定大纲逐节撰写，每节标题使用与大纲一致的格式（如一、二、三或对应标题）。
2. 总字数必须达到至少 ${wordCount} 字（可略多不可少），按大纲合理分配到各节，每节写足字数，全文写满 ${wordCount} 字后再结束。
3. 只输出报告正文，不要输出“好的”“以下是”等前缀。
4. 使用中文，内容专业、数据与逻辑可信。
5. ${refRule}`;

    const referenceBlocks: string[] = [];
    if (hasLocalRef) {
      referenceBlocks.push(`【重点引用资料（本地文章，正文须重点引用）】\n\n${referenceText!.trim()}`);
    }
    if (hasKnowledge) {
      referenceBlocks.push(`【知识库检索（可适当引用补充）】\n\n${knowledgeText}`);
    }

    const userContent = [
      `报告主题：${topic}`,
      `字数要求：全文至少 ${wordCount} 字，宁多勿少，写满再结束`,
      `报告模板：${reportTemplate}`,
      coreContent ? `背景与要点：\n${coreContent}` : "",
      referenceBlocks.length ? referenceBlocks.join("\n\n") : "",
      `大纲：\n${outlineText}`,
    ]
      .filter(Boolean)
      .join("\n\n");

    const messages = [
      new SystemMessage(systemPrompt),
      new HumanMessage(userContent),
    ];

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const safeEnqueue = (data: Uint8Array) => {
          try {
            controller.enqueue(data);
            return true;
          } catch {
            return false;
          }
        };
        const safeClose = () => {
          try {
            controller.close();
          } catch {
            // 客户端已断开，忽略
          }
        };
        try {
          const llmStream = await llm.stream(messages);
          for await (const chunk of llmStream) {
            const text =
              typeof chunk.content === "string"
                ? chunk.content
                : String(chunk.content ?? "");
            if (text && !safeEnqueue(encoder.encode(text))) break;
          }
          safeClose();
        } catch (e) {
          console.error("[body stream error]", e);
          safeEnqueue(encoder.encode("\n\n[生成中断或出错，请重试。]"));
          safeClose();
        }
      },
    });

    const knowledgeRecordCount = hasKnowledge ? knowledgeText.split("\n\n---\n\n").length : 0;
    return new Response(stream, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Knowledge-Used": hasKnowledge ? "true" : "false",
        "X-Knowledge-Query": hasKnowledge ? topic : "",
        "X-Knowledge-Record-Count": String(knowledgeRecordCount),
      },
    });
  } catch (e) {
    console.error("[body API error]", e);
    return new Response(
      JSON.stringify({
        error: e instanceof Error ? e.message : "生成正文失败，请稍后重试",
      }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}
