import { Agent, AgentFunctionResult, ChatLogs, ChatMessageBuilder, LlmApi, Tokenizer } from "@evo-ninja/agent-utils";
import { AgentFunctionBase } from "../AgentFunctionBase";
import { AgentBaseContext } from "../AgentBase";
import { DirectoryChunker } from "@evo-ninja/agent-utils";

interface SummarizeDirectoryParameters {
  subDirectory?: string;
}

export class SummarizeDirectoryFunction extends AgentFunctionBase<SummarizeDirectoryParameters> {
  constructor(private _llm: LlmApi, private _tokenizer: Tokenizer) {
    super();
  }

  name: string = "summarizeDirectory";
  description: string = `Summarize the contents of a directory. Includes file names and brief descriptions.`;
  parameters: any = {
    type: "object",
    properties: {
      subDirectory: {
        type: "string",
        description: "sub-directory to be summarized (default: root directory)"
      }
    },
    required: [],
    additionalProperties: false
  };

  buildExecutor(agent: Agent<unknown>, context: AgentBaseContext): (params: SummarizeDirectoryParameters, rawParams?: string | undefined) => Promise<AgentFunctionResult> {
    return async (params: SummarizeDirectoryParameters, rawParams?: string): Promise<AgentFunctionResult> => {
      const prompt = (summary: string | undefined, chunk: string) => {
        return `Your job is to summarize the contents of the following files. In this summary please structure your response on a per-file basis. NOTE: some files have been chunked, line numbers are annotated.\n
                ${summary ? `An existing summary already exists, you MUST modify this to contain all new details, WITHOUT LOOSING INFORMATION already present within the summary.\n\`\`\`${summary}\`\`\`\n`: ""}
                Chunk:\n\`\`\`\n${chunk}\n\`\`\`\n`;
      }

      const fuzTokens = 200;
      const maxInputTokens = this._llm.getMaxContextTokens() - (this._llm.getMaxResponseTokens() + fuzTokens);
      const chunker = new DirectoryChunker({ maxChunkSize: maxInputTokens })
      const chunks = chunker.chunk({
        workspace: context.workspace,
        directory: params.subDirectory
      });

      let summary: string | undefined = undefined;

      for (const chunk of chunks) {
        const chatLogs = ChatLogs.from([{
          role: "user",
          content: prompt(summary, chunk)
        }], [], this._tokenizer);

        const resp = await this._llm.getResponse(chatLogs);

        summary = resp?.content || "";
      }

      return {
        outputs: [],
        messages: [
          ChatMessageBuilder.functionCall(this.name, rawParams),
          ...ChatMessageBuilder.functionCallResultWithVariables(this.name, summary || "", context.variables)
        ]
      };
    }
  }
}