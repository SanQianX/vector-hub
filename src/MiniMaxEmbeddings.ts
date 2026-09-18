import { EmbeddingsModel, EmbeddingsResponse } from "./types";
import { Colorize } from "./internals";

/**
 * Options for configuring a `MiniMaxEmbeddings` instance.
 */
export interface MiniMaxEmbeddingsOptions {
    /**
     * API key to use when calling the MiniMax API.
     * @remarks
     * Either a pay-as-you-go API key or a Coding/Token Plan subscription key
     * (`sk-cp-...`) can be used. Plan usage deducts from the subscription's
     * shared quota. A new API key can be created at https://platform.minimaxi.com.
     */
    apiKey: string;

    /**
     * Optional. Endpoint to use when calling the MiniMax API.
     * @remarks
     * Defaults to `https://api.minimax.cn` and should not include a trailing `/v1`
     * as the request path is appended automatically. Other known endpoints are
     * `https://api.minimaxi.com` (China) and `https://api.minimax.io` (international).
     */
    endpoint?: string;

    /**
     * Model to use for embeddings.
     * @remarks
     * Defaults to `embo-01`, which returns 1536 dimension vectors.
     */
    model?: string;

    /**
     * Optional. Maximum number of tokens that can be sent to the embedding model.
     * @remarks
     * The default is `500`.
     */
    maxTokens?: number;

    /**
     * Optional. Whether to log requests to the console.
     * @remarks
     * This is useful for debugging prompts and defaults to `false`.
     */
    logRequests?: boolean;

    /**
     * Optional. Retry policy to use when calling the MiniMax API.
     * @remarks
     * The default retry policy is `[2000, 5000]` which means that the first retry will be after
     * 2 seconds and the second retry will be after 5 seconds.
     */
    retryPolicy?: number[];

    /**
     * Optional. Request options to use when calling the MiniMax API.
     */
    requestConfig?: RequestInit;
}

/**
 * The type of embedding being generated.
 * @remarks
 * The MiniMax API uses asymmetric embeddings, so texts being indexed must be
 * marked as `db` and search queries as `query`. Mixing the two up will
 * significantly degrade retrieval quality.
 */
type MiniMaxEmbeddingsType = 'db' | 'query';

interface MiniMaxEmbeddingsRequest {
    model: string;
    texts: string[];
    type: MiniMaxEmbeddingsType;
}

interface MiniMaxEmbeddingsResponse {
    vectors?: number[][];
    total_tokens?: number;
    base_resp?: {
        status_code: number;
        status_msg: string;
    };
}

/**
 * An `EmbeddingsModel` for calling MiniMax hosted embedding models.
 * @remarks
 * The MiniMax embeddings API is not OpenAI-compatible. It expects a `texts`
 * array instead of `input`, requires a `type` of `db` or `query` to distinguish
 * documents being indexed from search queries, and returns the vectors in a
 * top-level `vectors` field. This class adapts that format to vectra's
 * `EmbeddingsModel` interface.
 *
 * Usage:
 * ```ts
 * const embeddings = new MiniMaxEmbeddings({ apiKey: process.env.MINIMAX_API_KEY! });
 * const docs = new LocalDocumentIndex({ folderPath: './my-index', embeddings });
 * ```
 */
export class MiniMaxEmbeddings implements EmbeddingsModel {
    private readonly UserAgent = 'AlphaWave';

    public readonly maxTokens;

    /**
     * Options the client was configured with.
     */
    public readonly options: MiniMaxEmbeddingsOptions;

    /**
     * Creates a new `MiniMaxEmbeddings` instance.
     * @param options Options for configuring the client.
     */
    public constructor(options: MiniMaxEmbeddingsOptions) {
        // Strip undefined keys before merging — callers commonly build options
        // objects with optional fields set to undefined, and Object.assign
        // would override the defaults below with those undefined values.
        const provided = Object.fromEntries(
            Object.entries(options).filter(([, value]) => value !== undefined),
        );
        this.options = Object.assign({
            endpoint: 'https://api.minimax.cn',
            model: 'embo-01',
            maxTokens: 500,
            retryPolicy: [2000, 5000],
        }, provided) as MiniMaxEmbeddingsOptions;

        // Cleanup endpoint
        let endpoint = this.options.endpoint!.trim();
        if (endpoint.endsWith('/')) {
            endpoint = endpoint.substring(0, endpoint.length - 1);
        }
        this.options.endpoint = endpoint;
        this.maxTokens = this.options.maxTokens!;
    }

    /**
     * Gets the model being used for embeddings.
     */
    public get model(): string {
        return this.options.model!;
    }

    /**
     * Creates embeddings for the given inputs using the MiniMax API.
     * @remarks
     * A string input is treated as a search query and an array input as
     * documents being indexed. This matches how `LocalDocumentIndex` calls the
     * model: a single query string for `queryDocuments()` and an array of
     * document chunks for `upsertDocument()`.
     * @param inputs Text inputs to create embeddings for.
     * @returns A `EmbeddingsResponse` with a status and the generated embeddings or a message when an error occurs.
     */
    public async createEmbeddings(inputs: string | string[]): Promise<EmbeddingsResponse> {
        if (this.options.logRequests) {
            console.log(Colorize.title('EMBEDDINGS REQUEST:'));
            console.log(Colorize.output(inputs));
        }

        const startTime = Date.now();
        const response = await this.post(`${this.options.endpoint}/v1/embeddings`, {
            model: this.options.model,
            texts: Array.isArray(inputs) ? inputs : [inputs],
            type: typeof inputs == 'string' ? 'query' : 'db',
        } as MiniMaxEmbeddingsRequest);

        const data = await response.json() as MiniMaxEmbeddingsResponse;

        if (this.options.logRequests) {
            console.log(Colorize.title('RESPONSE:'));
            console.log(Colorize.value('status', response.status));
            console.log(Colorize.value('duration', Date.now() - startTime, 'ms'));
            console.log(Colorize.output(data));
        }

        // Process response
        // The MiniMax API reports most errors with an HTTP 200 status and a
        // non-zero `base_resp.status_code` (e.g. 2013 for invalid params).
        if (response.status < 300 && (data.base_resp?.status_code ?? 0) == 0) {
            return {
                status: 'success',
                output: data.vectors,
                model: this.options.model,
                usage: data.total_tokens != undefined ? { total_tokens: data.total_tokens } : undefined,
            };
        } else if (response.status == 429) {
            return { status: 'rate_limited', message: `The embeddings API returned a rate limit error.` }
        } else {
            const message = data.base_resp?.status_code != undefined ?
                `The embeddings API returned an error code of ${data.base_resp.status_code}: ${data.base_resp.status_msg}` :
                `The embeddings API returned an error status of ${response.status}: ${response.statusText}`;
            return { status: 'error', message };
        }
    }

    /**
     * @private
     */
    private async post(url: string, body: object, retryCount = 0): Promise<Response> {
        // Initialize headers from requestConfig
        const baseHeaders = new Headers((this.options.requestConfig?.headers as Record<string, string>) ?? {});

        // Set defaults if not already provided
        if (!baseHeaders.has('Content-Type')) {
            baseHeaders.set('Content-Type', 'application/json');
        }
        if (!baseHeaders.has('User-Agent')) {
            baseHeaders.set('User-Agent', this.UserAgent);
        }
        if (!baseHeaders.has('Authorization')) {
            baseHeaders.set('Authorization', `Bearer ${this.options.apiKey}`);
        }

        // Send request
        const response = await fetch(url, {
            ...this.options.requestConfig,
            method: 'POST',
            headers: baseHeaders,
            body: JSON.stringify(body),
        });

        // Check for rate limit error
        if (response.status == 429 && Array.isArray(this.options.retryPolicy) && retryCount < this.options.retryPolicy.length) {
            const delay = this.options.retryPolicy[retryCount];
            await new Promise((resolve) => setTimeout(resolve, delay));
            return this.post(url, body, retryCount + 1);
        } else {
            return response;
        }
    }
}
