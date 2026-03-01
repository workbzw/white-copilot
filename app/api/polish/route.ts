import { NextRequest } from "next/server";
import { chatCompletion } from "@/lib/siliconflow";

export const maxDuration = 30;

type Action = "polish" | "simplify" | "expand";

const ACTION_PROMPTS: Record<
  Action,
  { system: string; userPrefix: string }
> = {
  polish: {
    system: `你是一名专业文本润色助手。用户会给你一段中文文本，请在不改变原意的前提下润色，使表述更准确、流畅、得体。只输出润色后的整段文字，不要加「润色结果：」等前缀或任何解释。`,
    userPrefix: "请润色以下文本：\n\n",
  },
  simplify: {
    system: `你是一名专业文本精简助手。用户会给你一段中文文本，请精简表述、去掉冗余，保留核心信息。只输出精简后的整段文字，不要加任何前缀或解释。`,
    userPrefix: "请精简以下文本：\n\n",
  },
  expand: {
    system: `你是一名专业文本扩充助手。用户会给你一段中文文本，请在保持原意的基础上适当扩充、补充说明或举例，使内容更充实。只输出扩充后的整段文字，不要加任何前缀或解释。`,
    userPrefix: "请扩充以下文本：\n\n",
  },
};

/**
 * POST body: { text: string, action?: "polish" | "simplify" | "expand" }
 * 返回 JSON: { text: string } 或 { error: string }
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

    const input = (body.text as string)?.trim() ?? "";
    const action: Action =
      body.action === "simplify" || body.action === "expand"
        ? body.action
        : "polish";

    if (!input) {
      return new Response(
        JSON.stringify({ error: "未提供待处理文本" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const { system, userPrefix } = ACTION_PROMPTS[action];
    const messages = [
      { role: "system" as const, content: system },
      { role: "user" as const, content: userPrefix + input },
    ];
    const text = (await chatCompletion({
      messages,
      temperature: 0.4,
      maxTokens: 2048,
    })).trim();

    return new Response(JSON.stringify({ text }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("[polish API error]", e);
    return new Response(
      JSON.stringify({
        error: e instanceof Error ? e.message : "处理失败，请重试",
      }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}
