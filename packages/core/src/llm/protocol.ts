import type { ModelRequest, ModelResponse } from "./types.ts";

/** 单个协议适配器负责请求路径、请求体和响应流转换。 */
export interface ProtocolAdapter {
	readonly id: ModelRequest["api"];
	endpoint(baseUrl: string): string;
	headers(request: ModelRequest): Headers;
	body(request: ModelRequest): Record<string, unknown>;
	parse(
		stream: ReadableStream<Uint8Array>,
		request: ModelRequest,
		onText?: (text: string) => void,
		signal?: AbortSignal,
		onReasoning?: (text: string) => void,
	): Promise<ModelResponse>;
}
