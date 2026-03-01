import { NextRequest } from "next/server";
import { getSiliconFlowChatModel } from "@/lib/siliconflow";
import { retrieveFromKnowledge } from "@/lib/knowledge-retrieve";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";

export const maxDuration = 60;

/**
 * 按节生成报告正文，供前端并发生成多节使用。
 * POST body: { outline, topic, sectionIndex, wordCountPerSection?, reportTemplate?, coreContent?, styleMode? }
 * 返回 JSON: { content: string }
 */
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
    const sectionIndex = Number(body.sectionIndex);
    const sectionTitle =
      outline?.[sectionIndex] ?? `第 ${sectionIndex + 1} 节`;
    const wordCountPerSection = Math.max(
      20,
      Math.floor(Number(body.wordCountPerSection) || 600)
    );
    // 按本节字数控制 token，尊重用户设置的小字数
    const maxTokens = Math.min(16384, Math.max(256, Math.ceil(wordCountPerSection * 1.5)));

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
    let knowledgeText = "";
    if (process.env.KNOWLEDGE_API_KEY?.trim() && knowledgeDatasetIds.length > 0) {
      try {
        const sectionQuery = `${topic} ${sectionTitle}`.trim();
        knowledgeText = await retrieveFromKnowledge(sectionQuery, {
          topK: 5,
          datasetIds: knowledgeDatasetIds,
        });
      } catch (e) {
        console.warn("[body-section] 知识库检索失败，继续生成本节", e);
      }
    }
    const hasLocalRef = !!referenceText;
    const hasKnowledge = !!knowledgeText?.trim();

    if (!outline?.length || !topic || !Number.isInteger(sectionIndex) || sectionIndex < 0) {
      return new Response(
        JSON.stringify({ error: "缺少报告主题、大纲或节序号" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const llm = getSiliconFlowChatModel({
      temperature: 0.6,
      maxTokens,
    });

    const styleHint =
      styleMode === "standard"
        ? "请严格按标准公文格式与用语撰写，层次清晰、用语规范。"
        : "可适当发挥，保持专业、条理清晰。";

    const refRule =
      hasLocalRef && hasKnowledge
        ? "若同时提供了本地引用文章与知识库检索结果，则重点引用本地文章，适当引用知识库作为补充。"
        : "若用户提供了重点引用资料，本节正文中必须引用其中的关键数据、表述或观点，应明确体现资料内容，不得完全脱离资料发挥。";

    const systemPrompt = `你是一名专业报告撰写助手。请根据报告主题和大纲，只撰写其中某一节的内容。
${styleHint}
要求：
1. 本节标题为：${sectionTitle}。不要在正文中重复该标题，只写标题下方的正文。
2. 本节字数必须严格控制在 ${wordCountPerSection} 字，不得明显超出或不足，写满即止。
3. 只输出本节正文，不要输出“好的”“以下是”等前缀，不要写其他节。
4. 使用中文，内容专业、数据与逻辑可信。
5. ${refRule}`;

    const referenceBlocks: string[] = [];
    if (hasLocalRef) {
      referenceBlocks.push(`【重点引用资料（本地文章，本节须重点引用）】\n\n${referenceText}`);
    }
    if (hasKnowledge) {
      referenceBlocks.push(`【知识库检索（可适当引用补充）】\n\n${knowledgeText}`);
    }

    const outlineContext = outline.map((item, i) => `${i + 1}. ${item}`).join("\n");
    const userContent = [
      `报告主题：${topic}`,
      `字数要求：本节严格控制在 ${wordCountPerSection} 字（不得超出）`,
      `报告模板：${reportTemplate}`,
      coreContent ? `背景与要点：\n${coreContent}` : "",
      referenceBlocks.length ? referenceBlocks.join("\n\n") : "",
      `全文大纲（供参考）：\n${outlineContext}`,
      `请只撰写第 ${sectionIndex + 1} 节「${sectionTitle}」的正文。`,
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
            // ignore
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
          console.error("[body-section stream error]", e);
          safeEnqueue(encoder.encode("\n[本节生成中断或出错]"));
          safeClose();
        }
      },
    });

    const sectionQuery = `${topic} ${sectionTitle}`.trim();
    const knowledgeRecordCount = hasKnowledge ? knowledgeText.split("\n\n---\n\n").length : 0;
    return new Response(stream, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Knowledge-Used": hasKnowledge ? "true" : "false",
        "X-Knowledge-Query": hasKnowledge ? sectionQuery : "",
        "X-Knowledge-Record-Count": String(knowledgeRecordCount),
      },
    });
  } catch (e) {
    console.error("[body-section API error]", e);
    return new Response(
      JSON.stringify({
        error: e instanceof Error ? e.message : "本节生成失败，请重试",
      }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}
