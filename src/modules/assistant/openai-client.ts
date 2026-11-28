import { HttpError } from "../../shared/http/http-error";

const ENDPOINT = "https://api.openai.com/v1/responses";
const MAX_INPUT_LENGTH = 12_000;
const MAX_RESPONSE_BYTES = 256_000;

type OpenAiRequest = {
  instructions: string;
  input: string;
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function extractText(payload: unknown): string {
  const response = record(payload);
  if (!response || response.status !== "completed" || !Array.isArray(response.output)) {
    throw new HttpError(502, "Dịch vụ AI trả kết quả chưa hoàn chỉnh hoặc không hợp lệ.");
  }
  const texts: string[] = [];
  for (const rawItem of response.output) {
    const item = record(rawItem);
    if (!item || typeof item.type !== "string") {
      throw new HttpError(502, "Dịch vụ AI trả kết quả không hợp lệ.");
    }
    if (item.type === "reasoning") continue;
    if (item.type !== "message" || item.role !== "assistant" || !Array.isArray(item.content)) {
      throw new HttpError(502, "Dịch vụ AI trả nội dung không được hỗ trợ.");
    }
    for (const rawContent of item.content) {
      const content = record(rawContent);
      if (content?.type === "refusal") throw new HttpError(502, "Dịch vụ AI từ chối yêu cầu.");
      if (content?.type !== "output_text" || typeof content.text !== "string") {
        throw new HttpError(502, "Dịch vụ AI trả nội dung không hợp lệ.");
      }
      texts.push(content.text);
    }
  }
  const text = texts.join("\n").trim();
  if (!text) throw new HttpError(502, "Dịch vụ AI không trả lời.");
  return text;
}

async function readJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body) throw new HttpError(502, "Dịch vụ AI không trả nội dung.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let body = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new HttpError(502, "Phản hồi từ dịch vụ AI quá lớn.");
      }
      body += decoder.decode(chunk.value, { stream: true });
    }
    body += decoder.decode();
  } catch (error) {
    if (error instanceof HttpError) throw error;
    console.error("OpenAI response stream failed.");
    if (signal.aborted && signal.reason instanceof Error && signal.reason.name === "TimeoutError") {
      throw new HttpError(504, "Dịch vụ AI mất quá nhiều thời gian. Vui lòng thử lại.");
    }
    throw new HttpError(502, "Không đọc được phản hồi từ dịch vụ AI.");
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new HttpError(502, "Dịch vụ AI trả dữ liệu không hợp lệ.");
  }
}

export async function requestOpenAiText(request: OpenAiRequest): Promise<string> {
  if (!request || typeof request.instructions !== "string" || typeof request.input !== "string" ||
      !request.instructions.trim() || !request.input.trim() ||
      request.instructions.length + request.input.length > MAX_INPUT_LENGTH) {
    throw new HttpError(400, "Nội dung gửi đến trợ lý không hợp lệ hoặc quá dài.");
  }
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  const model = process.env.OPENAI_MODEL?.trim();
  if (!apiKey || !model || !/^[a-zA-Z0-9._:-]{1,128}$/.test(model)) {
    throw new HttpError(503, "Dịch vụ AI chưa được cấu hình đầy đủ.");
  }

  let response: Response;
  const signal = AbortSignal.timeout(30_000);
  try {
    response = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model, instructions: request.instructions, input: request.input,
        store: false, max_output_tokens: 1024,
      }),
      signal,
      redirect: "error",
    });
  } catch (error) {
    console.error("OpenAI request failed.");
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new HttpError(504, "Dịch vụ AI mất quá nhiều thời gian. Vui lòng thử lại.");
    }
    throw new HttpError(503, "Không kết nối được dịch vụ AI.");
  }
  if (!response.ok) {
    console.error(`OpenAI request returned HTTP ${response.status}.`);
    if (response.status === 429) throw new HttpError(503, "Dịch vụ AI đang giới hạn yêu cầu. Vui lòng thử lại sau.");
    throw new HttpError(502, "Dịch vụ AI không xử lý được yêu cầu. Vui lòng kiểm tra cấu hình và thử lại.");
  }
  return extractText(await readJson(response, signal));
}
