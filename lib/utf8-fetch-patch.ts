/**
 * 在模块加载时包装 Request 与 fetch，将字符串 body 转为 UTF-8 Buffer，
 * 避免 Node/undici 把字符串当 ByteString（仅 0–255）处理导致中文报错。
 * 必须在引用 LangChain/OpenAI 之前 import 本文件。
 */

if (typeof globalThis.Request !== "undefined") {
  const OrigRequest = globalThis.Request;
  const PatchedRequest = function (
    input: RequestInfo | URL,
    init?: RequestInit
  ): Request {
    if (init?.body != null && typeof init.body === "string") {
      init = { ...init, body: Buffer.from(init.body, "utf8") };
    }
    return new OrigRequest(input, init);
  };
  PatchedRequest.prototype = OrigRequest.prototype;
  (globalThis as { Request: typeof globalThis.Request }).Request = PatchedRequest as unknown as typeof globalThis.Request;
}

if (typeof globalThis.fetch === "function") {
  const origFetch = globalThis.fetch;
  globalThis.fetch = function (
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> {
    if (init?.body != null && typeof init.body === "string") {
      init = { ...init, body: Buffer.from(init.body, "utf8") };
    }
    return origFetch.call(globalThis, input, init);
  };
}
