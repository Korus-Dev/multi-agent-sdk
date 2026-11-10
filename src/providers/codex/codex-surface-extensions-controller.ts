import type { CodexServerRequestResponder, ServerRequest, v2 } from 'codex-sdk';
import type { CodexSurfaceJsonValue, CreateCodexConversationOptions } from '../../core/surface';
import {
  assertNoMcpConfigCollision,
  mcpServerConfig,
  normalizeMcpServers,
  type CodexMcpServerDefinition,
} from './codex-surface-mcp';
import { errorMessage } from './codex-surface-prompts';
import type {
  CodexConversationLoadOptions,
  CodexDynamicTool,
  CodexSurfaceExtension,
  CodexThreadStartExtension,
} from './codex-surface-contracts';

type DynamicToolRequest = Extract<ServerRequest, { method: 'item/tool/call' }>;

export class CodexSurfaceExtensionsController {
  private readonly dynamicTools = new Map<string, CodexDynamicTool>();
  readonly defaultMcpServers: readonly CodexMcpServerDefinition[];

  constructor(
    private readonly extensions: readonly CodexSurfaceExtension[],
    mcpServers: readonly CodexMcpServerDefinition[],
    private readonly hostOptionsForThread: (threadId: string) => CodexConversationLoadOptions | undefined,
  ) {
    this.defaultMcpServers = normalizeMcpServers(mcpServers);
    for (const extension of extensions) {
      for (const tool of extension.dynamicTools ?? []) {
        const name = tool.name.trim();
        if (!name) throw new Error('Dynamic tool names cannot be empty');
        if (this.dynamicTools.has(name)) throw new Error(`Duplicate dynamic tool '${name}'`);
        this.dynamicTools.set(name, { ...tool, name });
      }
    }
  }

  hasDynamicTools(): boolean {
    return this.dynamicTools.size > 0;
  }

  dynamicToolSpecs(): v2.DynamicToolSpec[] {
    return [...this.dynamicTools.values()].map((tool) => ({
      type: 'function',
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema as v2.DynamicToolFunctionSpec['inputSchema'],
      ...(tool.deferLoading === undefined ? {} : { deferLoading: tool.deferLoading }),
    }));
  }

  async conversationExtension(
    context: Parameters<NonNullable<CodexSurfaceExtension['configureConversation']>>[0],
    createOptions: CreateCodexConversationOptions = {},
    mcpServers: readonly CodexMcpServerDefinition[] = this.defaultMcpServers,
  ): Promise<CodexThreadStartExtension> {
    const config: Record<string, CodexSurfaceJsonValue> = mcpServerConfig(mcpServers);
    const developerInstructions: string[] = [];
    let baseInstructions: string | undefined;
    for (const extension of this.extensions) {
      if (!extension.configureConversation) continue;
      const contribution = await extension.configureConversation(context);
      if (contribution.config) {
        assertNoMcpConfigCollision(contribution.config, mcpServers);
        Object.assign(config, contribution.config);
      }
      if (contribution.baseInstructions !== undefined) baseInstructions = contribution.baseInstructions;
      if (contribution.developerInstructions?.trim()) {
        developerInstructions.push(contribution.developerInstructions.trim());
      }
    }
    if (createOptions.config) {
      assertNoMcpConfigCollision(createOptions.config, mcpServers);
      Object.assign(config, createOptions.config);
    }
    if (createOptions.baseInstructions !== undefined) baseInstructions = createOptions.baseInstructions;
    if (createOptions.developerInstructions?.trim()) {
      developerInstructions.push(createOptions.developerInstructions.trim());
    }
    return {
      ...(baseInstructions === undefined ? {} : { baseInstructions }),
      ...(Object.keys(config).length === 0 ? {} : { config }),
      ...(developerInstructions.length === 0
        ? {}
        : { developerInstructions: developerInstructions.join('\n\n') }),
    };
  }

  async handleDynamicToolCall(
    request: DynamicToolRequest,
    responder: CodexServerRequestResponder<'item/tool/call'>,
  ): Promise<void> {
    if (request.params.namespace !== null) {
      responder.reject({
        code: -32601,
        message: `Dynamic tool namespace '${request.params.namespace}' is not configured`,
      });
      return;
    }
    const tool = this.dynamicTools.get(request.params.tool);
    if (!tool) {
      responder.reject({ code: -32601, message: `Unknown dynamic host tool '${request.params.tool}'` });
      return;
    }
    try {
      const result = await tool.execute({
        callId: request.params.callId,
        conversationId: request.params.threadId,
        turnId: request.params.turnId,
        arguments: request.params.arguments as CodexSurfaceJsonValue,
        extensionContext: this.hostOptionsForThread(request.params.threadId)?.extensionContext,
      });
      const normalized = typeof result === 'string'
        ? { content: [{ type: 'text' as const, text: result }], success: true }
        : { content: result.content, success: result.success ?? true };
      responder.resolve({
        success: normalized.success,
        contentItems: normalized.content.map((item) => item.type === 'image'
          ? { type: 'inputImage' as const, imageUrl: item.imageUrl }
          : { type: 'inputText' as const, text: item.text }),
      });
    } catch (error) {
      responder.resolve({
        success: false,
        contentItems: [{ type: 'inputText', text: errorMessage(error) }],
      });
    }
  }
}
