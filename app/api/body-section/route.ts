import { NextRequest } from "next/server";
import { getSiliconFlowChatModel } from "@/lib/siliconflow";
import { retrieveFromKnowledge } from "@/lib/knowledge-retrieve";
import { getSystemPersona } from "@/lib/prompt-persona";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";

export const maxDuration = 60;

/** 去掉节标题前的「一、」「二、」「第一章」「1.」等序号，仅用于知识库检索 query，提高语义匹配 */
function stripSectionNumeralPrefix(title: string): string {
  const t = title.trim();
  // 一、二、… 十一、十二、… 或 第一章、第一节、第一部分、第一项 等
  const withPunct = t.replace(
    /^\s*([一二三四五六七八九十百千零廿卅]+|[一二三四五六七八九十]+)\s*[、．.]\s*/u,
    ""
  );
  if (withPunct !== t) return withPunct.trim();
  const withChapter = t.replace(
    /^\s*第[一二三四五六七八九十百千零廿卅\d]+[章部分节项条款]\s*[、．.]?\s*/u,
    ""
  );
  if (withChapter !== t) return withChapter.trim();
  // 1. 2. 1、 或 （一）（二）
  const withArabic = t.replace(/^\s*\d+\s*[、．.]\s*/u, "");
  if (withArabic !== t) return withArabic.trim();
  const withParen = t.replace(/^\s*[（(][一二三四五六七八九十]+[)）]\s*/u, "");
  if (withParen !== t) return withParen.trim();
  return t;
}

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
    // 按本节字数限制 token：需大于本节字数对应 token，否则会截断卡在 99%（中文约 1～1.5 token/字）
    const maxTokens = Math.min(16384, Math.max(128, Math.ceil((wordCountPerSection * 1.8) + 150)));
    if (process.env.NODE_ENV !== "production") {
      console.log("[body-section] wordCountPerSection:", wordCountPerSection, "maxTokens:", maxTokens);
    }

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
    type KnowledgeStatus = "used" | "no_api_key" | "no_dataset" | "retrieval_failed" | "no_results";
    // 快速生成：知识库检索用「总标题 + 当前节标题（去掉一、二、等序号）」避免序号干扰语义匹配
    const sectionTitleForQuery = stripSectionNumeralPrefix(sectionTitle);
    const sectionQuery = `${topic} ${sectionTitleForQuery}`.trim();
    let knowledgeText = "";
    let knowledgeStatus: KnowledgeStatus = "no_dataset";

    if (!process.env.KNOWLEDGE_API_KEY?.trim()) {
      knowledgeStatus = "no_api_key";
    } else if (knowledgeDatasetIds.length === 0) {
      knowledgeStatus = "no_dataset";
    } else {
      try {
        knowledgeText = await retrieveFromKnowledge(sectionQuery, {
          topK: 5,
          datasetIds: knowledgeDatasetIds,
        });
        if (knowledgeText?.trim()) {
          knowledgeStatus = "used";
        } else {
          knowledgeStatus = "no_results";
        }
      } catch (e) {
        console.warn("[body-section] 知识库检索失败，继续生成本节", e);
        knowledgeStatus = "retrieval_failed";
      }
    }
    const hasLocalRef = !!referenceText;
    const hasKnowledge = knowledgeStatus === "used";

    if (!outline?.length || !topic || !Number.isInteger(sectionIndex) || sectionIndex < 0) {
      return new Response(
        JSON.stringify({ error: "缺少报告主题、大纲或节序号" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const styleHint =
      styleMode === "standard"
        ? "请严格按标准公文格式与用语撰写，层次清晰、用语规范。"
        : "可适当发挥，保持专业、条理清晰。";

    const refRule =
      hasLocalRef && hasKnowledge
        ? "若同时提供了本地引用文章与知识库检索结果，则重点引用本地文章，适当引用知识库作为补充。"
        : "若用户提供了重点引用资料，本节正文中必须引用其中的关键数据、表述或观点，应明确体现资料内容，不得完全脱离资料发挥。";

    const referenceBlocks: string[] = [];
    if (hasLocalRef) {
      referenceBlocks.push(`【重点引用资料（本地文章，本节须重点引用）】\n\n${referenceText.normalize("NFC")}`);
    }
    if (hasKnowledge) {
      referenceBlocks.push(`【知识库检索（可适当引用补充）】\n\n${knowledgeText.normalize("NFC")}`);
    }
    const referencesSection = referenceBlocks.length ? `\n\n【以下为参考资料，撰写时须按要求引用】\n\n${referenceBlocks.join("\n\n")}` : "";

    const systemPrompt = `${getSystemPersona()}

---

【本次任务】你作为上述研究员，根据报告主题和大纲，只撰写其中某一节的内容。
${styleHint}
要求：
1. 本节标题为：${sectionTitle}。禁止在正文开头重复该标题（不要再次写「${sectionTitle}」或「一、」「二、」等段落标题），直接从第一段正文开始，只写标题下方的正文。
2. 本节正文必须达到约 ${wordCountPerSection} 字（中文，含标点）。务必写满约 ${wordCountPerSection} 字后再结束，不要提前收尾；可略超但不得明显不足。字数按正文纯文字计算，不含 Markdown 符号；勿堆砌格式，以自然段落为主。
3. 只输出本节正文，不要输出“好的”“以下是”等前缀，不要写其他节；开头不要有任何无关内容（如寒暄、标题重复、过渡句等），直接输出正文第一段。
4. 使用中文，内容专业、数据与逻辑可信。
5. ${refRule}${referencesSection}`;

    const outlineContext = outline.map((item, i) => `${i + 1}. ${item}`).join("\n");
    const userContent = [
      `报告主题：${topic.normalize("NFC")}`,
      `字数要求：本节必须写满约 ${wordCountPerSection} 字（中文），不要提前结束，务必达到约 ${wordCountPerSection} 字。`,
      `报告模板：${reportTemplate}`,
      coreContent ? `背景与要点：\n${coreContent}` : "",
      `全文大纲（供参考）：\n${outlineContext}`,
      `请只撰写第 ${sectionIndex + 1} 节「${sectionTitle}」的正文，写满约 ${wordCountPerSection} 字后结束。`,
    ]
      .filter(Boolean)
      .join("\n\n");

    function encodeUtf8Chunk(text: string): Uint8Array {
      return new Uint8Array(Buffer.from(text, "utf8"));
    }
    const llm = getSiliconFlowChatModel({
      temperature: 0.6,
      maxTokens,
    });
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
        const emitError = (userMsg: string) => {
          safeEnqueue(encodeUtf8Chunk(userMsg));
          safeClose();
        };
        try {
          const messages = [
            new SystemMessage(systemPrompt),
            new HumanMessage(userContent),
          ];
          const llmStream = await llm.stream(messages);
          for await (const chunk of llmStream) {
            const text =
              typeof chunk.content === "string"
                ? chunk.content
                : String(chunk.content ?? "");
            if (!text) continue;
            if (!safeEnqueue(encodeUtf8Chunk(text))) break;
          }
          safeClose();
        } catch (e) {
          console.error("[body-section stream error]", e);
          emitError("\n[本节生成中断或出错]");
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  } catch (e) {
    console.error("[body-section API error]", e);
    const msg = e instanceof Error ? e.message : "本节生成失败，请重试";
    return new Response(
      JSON.stringify({ error: msg }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}
