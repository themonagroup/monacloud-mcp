export type AgentErrorPayload = {
  code: string;
  message: string;
  next_step: string;
  request_id?: string;
};

export class CloudError extends Error {
  readonly code: string;
  readonly nextStep: string;
  readonly status?: number;
  readonly details?: unknown;
  readonly requestId?: string;

  constructor(
    code: string,
    message: string,
    nextStep: string,
    options: { status?: number; details?: unknown; requestId?: string } = {},
  ) {
    super(message);
    this.name = 'CloudError';
    this.code = code;
    this.nextStep = nextStep;
    this.status = options.status;
    this.details = options.details;
    this.requestId = options.requestId;
  }
}

function safeMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : 'Lỗi không xác định';
}

export function toAgentError(error: unknown): AgentErrorPayload {
  if (error instanceof CloudError) {
    return {
      code: error.code,
      message: error.message,
      next_step: error.nextStep,
      ...(error.requestId ? { request_id: error.requestId } : {}),
    };
  }
  return {
    code: 'internal_error',
    message: safeMessage(error),
    next_step: 'Thử lại. Nếu lỗi lặp lại, kiểm tra cấu hình MCP và trạng thái tại monacloud://status.',
  };
}

export const textResult = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
});

export const errorResult = (error: unknown) => ({
  isError: true,
  content: [{ type: 'text' as const, text: JSON.stringify(toAgentError(error), null, 2) }],
});

export async function runTool(fn: () => Promise<unknown> | unknown) {
  try {
    return textResult(await fn());
  } catch (error) {
    return errorResult(error);
  }
}
