import {
  EmbeddingApi,
  EmbeddingCreationResult,
  Tokenizer,
  splitArray,
} from "@evo-ninja/agents";

export class EmbeddingProxy implements EmbeddingApi {
  private MAX_RATE_LIMIT_RETRIES = 5;
  constructor(
    private tokenizer: Tokenizer,
    private config: {
      model: string;
      maxTokensPerInput: number;
      maxInputsPerRequest: number;
    }
  ) {}

  public async createEmbeddings(
    input: string | string[],
    tries?: number
  ): Promise<EmbeddingCreationResult[]> {
    const inputs = Array.isArray(input) ? input : [input];
    for (const input of inputs) {
      if (this.tokenizer.encode(input).length > this.config.maxTokensPerInput) {
        throw new Error(
          `Input exceeds max request tokens: ${this.config.maxTokensPerInput}`
        );
      }
    }

    const batchedInputs = splitArray(inputs, this.config.maxInputsPerRequest);

    const embeddingResponse = await fetch("/api/proxy/embeddings", {
      method: "POST",
      body: JSON.stringify({
        input: batchedInputs,
        model: this.config.model,
      }),
      headers: {
        "Content-Type": "application/json",
      },
    });

    if (!embeddingResponse.ok) {
      if (embeddingResponse.status === 400) {
        const error = await embeddingResponse.json();
        throw Error("Error from OpenAI Chat completion: " + error.error);
      }
      if (embeddingResponse.status === 429) {
        await new Promise((resolve) => setTimeout(resolve, 15000));
        if (!tries || tries < this.MAX_RATE_LIMIT_RETRIES) {
          return this.createEmbeddings(input, tries == undefined ? 0 : ++tries);
        }
      }
      throw Error("Error trying to get response from LLM");
    }
    const { embeddings } = await embeddingResponse.json();
    return embeddings;
  }
}