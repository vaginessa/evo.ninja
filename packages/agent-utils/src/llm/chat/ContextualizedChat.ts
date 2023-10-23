import {
  Chat,
  ChatLogType,
  ChatMessage
} from ".";
import {
  MessageChunker,
  LocalVectorDB,
  LocalCollection,
  BaseDocumentMetadata
} from "../../";

import { v4 as uuid } from "uuid";

type MsgIdx = number;

interface Chunk {
  msgIdx: MsgIdx;
}

type ChunkIdx = number;

interface DocumentMetadata extends BaseDocumentMetadata {
  tokens: number;
}

export class ContextualizedChat {

  private _chunks: Record<ChatLogType, Chunk[]> = {
    "persistent": [],
    "temporary": []
  };

  private _collections: Record<ChatLogType, LocalCollection<DocumentMetadata>>;

  constructor(
    private _rawChat: Chat,
    private _chunker: MessageChunker,
    db: LocalVectorDB
  ) {
    this._collections = {
      persistent: db.addCollection<DocumentMetadata>(uuid()),
      temporary: db.addCollection<DocumentMetadata>(uuid())
    };
  }

  get rawChat(): Chat {
    return this._rawChat;
  }

  async contextualize(context: string, tokenLimits: Record<ChatLogType, number>): Promise<Chat> {
    // Ensure all new messages have been processed
    await this._processNewMessages();

    // Aggregate all "persistent" chunks
    const persistentSmallChunks = this._aggregateSmallChunks(
      "persistent",
      tokenLimits["persistent"]
    );
    const persistentLargeChunks = await this._contextualizeChunks(
      context,
      "persistent",
      tokenLimits["persistent"] - persistentSmallChunks.tokens
    );

    // Aggregate all "temporary" chunks
    const temporaryChunks = await this._contextualizeChunks(
      context,
      "temporary",
      tokenLimits["temporary"]
    );

    // Sort persistent and temporary chunks
    const sorted = {
      persistent: [...persistentSmallChunks.chunks, ...persistentLargeChunks].sort(
        (a, b) => a.chunkIdx - b.chunkIdx
      ).map((x) => x.msg),
      temporary: temporaryChunks.sort(
        (a, b) => a.chunkIdx - b.chunkIdx
      ).map((x) => x.msg)
    };

    const chat = this._rawChat.cloneEmpty();
    chat.add("persistent", sorted.persistent);
    chat.add("temporary", sorted.temporary);
    return chat;
  }

  private _aggregateSmallChunks(type: ChatLogType, tokenLimit: number): {
    chunks: {
      msg: ChatMessage;
      chunkIdx: ChunkIdx;
    }[];
    tokens: number;
  } {
    const chunks: { msg: ChatMessage; chunkIdx: ChunkIdx; }[] = [];
    const chatLog = this._rawChat.chatLogs;
    const smallChunkIdxs = getSmallChunks(this._chunks[type]);
    let tokenCounter = 0;

    const addChunk = (chunkIdx: ChunkIdx): boolean => {
      const chunk = this._chunks[type][chunkIdx];
      const msgIdx = chunk.msgIdx;
      const msg = chatLog.getMsg(type, msgIdx);

      if (!msg) {
        throw Error("Incorrect msg index, this should never happen.");
      }

      const tokens = chatLog.getMsgTokens(type, msgIdx);
      if (tokenCounter + tokens > tokenLimit) {
        return false;
      }
      chunks.push({ msg, chunkIdx });
      tokenCounter += tokens;
      return true;
    };

    for (const smallChunkIdx of smallChunkIdxs) {
      if (!addChunk(smallChunkIdx)) {
        break;
      }
    }

    return { chunks, tokens: tokenCounter };
  }

  private async _contextualizeChunks(
    context: string,
    type: ChatLogType,
    tokenLimit: number
  ): Promise<{ msg: ChatMessage; chunkIdx: ChunkIdx; }[]> {
    // Search the collection for relevant chunks
    const results = await this._collections[type].search(context);

    // Aggregate as many as possible
    const chunks: { msg: ChatMessage; chunkIdx: ChunkIdx; }[] = [];
    let tokenCounter = 0;

    const addChunk = (chunkText: string, metadata: DocumentMetadata): boolean => {
      if (tokenCounter + metadata.tokens > tokenLimit) {
        return false;
      }

      const msg = JSON.parse(chunkText) as ChatMessage;
      const chunkIdx = metadata.index;
      chunks.push({ msg, chunkIdx });
      tokenCounter += metadata.tokens;
      return true;
    }

    for (const result of results) {
      const chunkText = result.text();
      const metadata = result.metadata();

      if (!metadata) {
        throw Error("metadata is missing, this should never happen")
      }

      if (!addChunk(chunkText, metadata)) {
        break;
      }
    }

    return chunks;
  }

  private async _processNewMessages(): Promise<void> {
    await this._processNewMessagesByType("persistent");
    await this._processNewMessagesByType("temporary");
  }

  private async _processNewMessagesByType(type: ChatLogType): Promise<void> {
    const messages = this._rawChat.chatLogs.get(type).msgs;

    // If no messages exist
    if (messages.length === 0) {
      return;
    }

    const lastProcessedIdx = getLastProcessedMessageIndex(this._chunks[type]);

    // If we've already processed all messages
    if (lastProcessedIdx === messages.length - 1) {
      return;
    }

    // Process all messages from lastProcessedIdx -> messages.length
    for (let i = lastProcessedIdx + 1; i < messages.length; ++i) {
      const message = messages[i];
      await this._processNewMessage(message, i, type);
    }
  }

  private async _processNewMessage(message: ChatMessage, msgIdx: number, type: ChatLogType): Promise<void> {

    const newChunks: string[] = [];

    // If the message is large and requires chunking
    if (this._chunker.shouldChunk(message)) { 
      newChunks.push(...this._chunker.chunk(message));
    } else {
      newChunks.push(JSON.stringify(message));
    }

    const chunks = this._chunks[type];

    // Save the starting chunk index (used later for document index)
    const startChunkIdx = chunks.length;

    // Add message index pointers for each new chunk
    for (const _ of newChunks) {
      chunks.push({ msgIdx });
    }

    // If we're processing persistent messages,
    // and it isn't a large message, early out
    if (type === "persistent" && newChunks.length === 1) {
      return;
    }

    // Create an array of chunk document metadata
    const metadatas: DocumentMetadata[] = newChunks.map((chunk, index) => ({
      index: startChunkIdx + index,
      tokens: this._rawChat.tokenizer.encode(chunk).length
    }));

    // Add the chunks to the vectordb collection
    await this._collections[type].add(newChunks, metadatas);

    return;
  }
}

// Helpers

function getLastProcessedMessageIndex(chunks: Chunk[]): number {
  const lastIdx = chunks.length - 1;

  // Nothing has been processed
  if (lastIdx < 0) {
    return -1;
  }

  // Return the message index of the last metadata
  return chunks[lastIdx].msgIdx;
}

function getSmallChunks(chunks: Chunk[]): ChunkIdx[] {
  const smallChunksIdxs: ChunkIdx[] = [];
  let prevMsgIdx = -1;

  // Iterate through and grab all unique msg indexes.
  // If a msg is not small, it will be chunked,
  // meaning more than one index will exist
  for (let i = 0; i < chunks.length; ++i) {
    const currMsgIdx = chunks[i].msgIdx;
    const nextMsgIdx = i + 1 < chunks.length ? chunks[i + 1] : -1;
    if (currMsgIdx !== prevMsgIdx && currMsgIdx !== nextMsgIdx) {
      // We've found a unique index with no siblings, it is small
      smallChunksIdxs.push(i);
    }
  }

  return smallChunksIdxs;
}