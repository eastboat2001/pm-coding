import type { Api, AssistantMessage, Context, Model, SimpleStreamOptions } from "./types.js";

/**
 * Node worker facade for one-shot model completion.
 *
 * Keep the provider registry behind a dynamic import so consumers that only need
 * this narrow contract do not pull every provider SDK declaration into their
 * compile-time type graph. The stream module still owns built-in registration.
 */
export async function completeSimple<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: SimpleStreamOptions,
): Promise<AssistantMessage> {
	const stream = await import("./stream.js");
	return stream.completeSimple(model, context, options);
}
