import type { CodexConversation, CodexHost } from './index';
import type { TurnStatus } from '../../core/codex-host';
import type { HarnessImageGenerationInput, HarnessImageGenerationResult } from '../../generation';
import { fileURLToPath } from 'node:url';
export type CodexImageGenerationOptions = {
  selectModel?: (models: readonly import('../../contracts').BackendModelOption[]) => { model: string; reasoningEffort?: string };
  log?: (message: string, details: Record<string, unknown>) => void;
};

/** Isolated native image generation; the caller chooses its model policy. */
export class CodexImageGeneration {
  private readonly jobs = new Set<AbortController>();
  constructor(private readonly host: CodexHost, private readonly options: CodexImageGenerationOptions = {}) {}

  close(): void { for (const job of this.jobs) job.abort(new Error('Codex image generation was cancelled.')); }

  async generate(input: HarnessImageGenerationInput, requestedSignal?: AbortSignal): Promise<HarnessImageGenerationResult> {
    const job = new AbortController();
    this.jobs.add(job);
    const signal = AbortSignal.any([job.signal, AbortSignal.timeout(8 * 60_000), ...(requestedSignal ? [requestedSignal] : [])]);
    let conversation: CodexConversation | undefined;
    let unsubscribe = () => {};
    let finished = false;
    let abort = () => {};
    try {
      signal.throwIfAborted();
      await this.host.connect();
      const models = await this.host.listModels({ includeHidden: false, forceReload: true });
      const selection = input.selection?.model ? input.selection : this.options.selectModel?.(models);
      if (!selection?.model) throw new Error('Select an image-generation model.');
      signal.throwIfAborted();
      const created = await this.host.createConversation({
        cwd: input.cwd, model: selection.model,
        ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
        permissionMode: 'read-only', approvalMode: 'never',
        config: { 'features.image_generation': true },
        baseInstructions: 'Generate the requested raster image using the built-in image-generation tool. Preserve the requested subject, style, text and transparency. Do not substitute SVG or code. Do not perform unrelated work or edit project files. Finish after generating the image.',
        threadSource: 'image_generation_bridge',
      }, { mcpServers: [] });
      if (!created.activeConversationId) throw new Error('Codex did not create the internal image conversation.');
      conversation = this.host.conversation(created.activeConversationId);
      signal.throwIfAborted();
      const statuses = new Map<string, TurnStatus>();
      let target: string | undefined;
      let resolve!: (status: TurnStatus) => void;
      let reject!: (error: unknown) => void;
      const completion = new Promise<TurnStatus>((done, failed) => { resolve = done; reject = failed; });
      // Provider notifications can arrive before sendMessage resolves.
      void completion.catch(() => {});
      abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      unsubscribe = conversation.onEvent(event => {
        if (event.type === 'turn.completed') {
          statuses.set(event.turnId, event.payload.status);
          if (event.turnId === target) resolve(event.payload.status);
        } else if (event.type === 'approval.requested' || event.type === 'clientRequest.requested') {
          job.abort(new Error('The internal image job requested an interactive approval or answer.'));
        } else if (event.type === 'turn.error' && !event.payload.willRetry) {
          job.abort(new Error(event.payload.error.message));
        }
      });
      const started = await conversation.sendMessage(input.prompt);
      signal.throwIfAborted();
      target = started.activeTurnId ?? started.turnIds.at(-1);
      if (!target) throw new Error('Codex did not start the image-generation turn.');
      const status = statuses.get(target) ?? started.turns.find(turn => turn.id === target && turn.status !== 'inProgress')?.status ?? await completion;
      if (status !== 'completed') throw new Error(`Codex image generation was ${status}.`);
      const messages = conversation.getSnapshot().messages.filter(message => message.role === 'assistant' && message.turnId === target);
      const generated = new Set(messages.flatMap(message => message.parts.flatMap(part =>
        part.type === 'tool' && part.title === 'image_generation' && part.status === 'completed' ? [part.id] : [])));
      const images: HarnessImageGenerationResult['images'] = [];
      for (const message of messages) for (const part of message.parts) {
        if (part.type !== 'media' || !part.itemId || !generated.has(part.itemId)) continue;
        const data = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=]+)$/i.exec(part.media.url);
        if (data) images.push({ data: data[2]!, mimeType: data[1]! });
        else if (part.media.url.startsWith('file:') && part.media.mimeType) images.push({ path: fileURLToPath(part.media.url), mimeType: part.media.mimeType });
      }
      if (!images.length) throw new Error('Codex completed without generating an image.');
      finished = true;
      return { images };
    } finally {
      signal.removeEventListener('abort', abort);
      unsubscribe();
      this.jobs.delete(job);
      if (conversation) {
        if (!finished) await conversation.interrupt().catch(() => {});
        await this.host.deleteConversation(conversation.id).catch(error => {
          this.options.log?.('conversation cleanup failed', { conversationId: conversation!.id, message: String(error) });
        });
        this.host.forgetConversation(conversation.id);
      }
    }
  }
}
