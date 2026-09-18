import { MiniMaxEmbeddings, OpenAIEmbeddings } from 'vectra';
import type { MiniMaxEmbeddingsOptions, OpenAIEmbeddingsOptions } from 'vectra';

/**
 * Creates a MiniMax embeddings model (`embo-01`, 1536 dims).
 *
 * @remarks
 * Accepts both pay-as-you-go API keys and Coding/Token Plan subscription
 * keys (`sk-cp-...`); plan usage deducts from the subscription's quota.
 */
export function createMiniMaxEmbeddings(apiKey: string, options?: Partial<MiniMaxEmbeddingsOptions>): MiniMaxEmbeddings {
    return new MiniMaxEmbeddings({ apiKey, ...options });
}

/**
 * Creates an OpenAI-compatible embeddings model.
 *
 * @remarks
 * Works with OpenAI, Azure-style deployments via options, or any
 * OpenAI-compatible endpoint (`endpoint` option).
 */
export function createOpenAIEmbeddings(options: OpenAIEmbeddingsOptions): OpenAIEmbeddings {
    return new OpenAIEmbeddings(options);
}
