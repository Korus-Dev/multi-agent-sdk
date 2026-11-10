import { describe, expect, it } from 'vitest';
import type { v2 } from '../../../codex-sdk/src/protocol';
import type {
  CodexConversationSummary,
  CodexSurfaceModel,
  CodexSurfaceRateLimitSnapshot,
  CodexSurfaceSnapshot,
  SurfaceMessage,
} from 'multi-agents-sdk/surface';
import {
  attachmentInput,
  conversationStatus,
  mergeRateLimitSnapshot,
  mergeSurfaceRateLimits,
  messageTurnId,
  messageTurnIdOrNull,
  surfaceAttachmentPart,
  surfaceMessageAttachments,
  surfaceMessageText,
  surfaceContextUsage,
  surfaceRateLimits,
  surfaceThreadStatus,
  threadToSummary,
  upsertConversation,
  validateAttachments,
  validatedSendOptions,
} from '../../src/providers/codex/codex-surface-data';

describe('Codex surface data codecs', () => {
  it('summarizes thread titles, timestamps, status, and recency', () => {
    expect(threadToSummary(thread({ name: '  Named  ', status: { type: 'active', activeFlags: [] } })))
      .toMatchObject({ title: 'Named', preview: 'First line\nsecond', status: 'active', turnCount: 1 });
    expect(threadToSummary(thread({ name: null, status: { type: 'systemError' }, recencyAt: null })))
      .toMatchObject({ title: 'First line', status: 'error', updatedAt: '2026-01-01T00:00:02.000Z' });
    expect(threadToSummary(thread({ name: ' ', preview: ' ', status: { type: 'idle' } })))
      .toMatchObject({ title: 'Untitled conversation', status: 'idle' });
    expect(threadToSummary(thread({
      name: null, preview: 'Title with padding   \nsecond', createdAt: 1, updatedAt: 2, recencyAt: null,
    }))).toMatchObject({
      title: 'Title with padding', createdAt: '1970-01-01T00:00:01.000Z',
      updatedAt: '1970-01-01T00:00:02.000Z',
    });
  });

  it('projects sub-agent thread identity without exposing protocol field names', () => {
    expect(threadToSummary(thread({
      sessionId: 'session-1',
      parentThreadId: 'thread-parent',
      agentNickname: 'Scout',
      agentRole: 'researcher',
    }))).toMatchObject({
      sessionId: 'session-1',
      parentConversationId: 'thread-parent',
      agentNickname: 'Scout',
      agentRole: 'researcher',
    });
    expect(threadToSummary(thread({
      sessionId: '', parentThreadId: null, agentNickname: null, agentRole: null,
    }))).not.toHaveProperty('parentConversationId');
  });

  it('upserts one conversation and sorts the result by recency', () => {
    const old = summary('same', '2026-01-01T00:00:01.000Z');
    const other = summary('other', '2026-01-01T00:00:03.000Z');
    const replacement = summary('same', '2026-01-01T00:00:02.000Z');
    expect(upsertConversation([old, other], replacement)).toStrictEqual([other, replacement]);
  });

  it('normalizes explicit model and attachment send options', () => {
    const state = snapshot([{ id: 'catalog-id', model: 'server-model', displayName: 'Model',
      supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'Medium' }] }]);
    expect(validatedSendOptions(state, {
      model: 'catalog-id',
      reasoningEffort: 'medium',
      attachments: [
        { type: 'file', path: ' /tmp/file.txt ', name: ' Notes ' },
        { type: 'image', path: ' /tmp/image.png ', detail: 'high' },
      ],
    })).toStrictEqual({
      model: 'server-model',
      reasoningEffort: 'medium',
      attachments: [
        { type: 'file', path: '/tmp/file.txt', name: 'Notes' },
        { type: 'image', path: '/tmp/image.png', detail: 'high' },
      ],
    });
    expect(validatedSendOptions(state, {})).toStrictEqual({});
    expect(() => validatedSendOptions(state, { model: 'missing' })).toThrow("Unknown model 'missing'");
    expect(() => validatedSendOptions(state, { reasoningEffort: 'high' }))
      .toThrow("Reasoning effort 'high' is not available");
    expect(() => validatedSendOptions({
      ...state,
      models: [{ ...state.models[0]!, serviceTiers: [{ id: 'priority', name: 'Priority', description: '' }] }],
    }, { serviceTier: 'flex' })).toThrow("Service tier 'flex' is not available");
  });

  it('rejects blank and relative attachment paths and preserves blank file names', () => {
    expect(() => validateAttachments([{ type: 'file', path: ' ' }])).toThrow('paths cannot be empty');
    expect(() => validateAttachments([{ type: 'image', path: 'relative.png' }]))
      .toThrow("must be absolute: 'relative.png'");
    expect(validateAttachments([{ type: 'file', path: '/tmp/file.txt', name: ' ' }]))
      .toStrictEqual([{ type: 'file', path: '/tmp/file.txt', name: ' ' }]);
    expect(validateAttachments([{ type: 'image', path: ' /tmp/image.png ', name: ' Image ' }]))
      .toStrictEqual([{ type: 'image', path: '/tmp/image.png', name: ' Image ' }]);
  });

  it('encodes file and image attachments for app-server input', () => {
    expect(attachmentInput({ type: 'file', path: '/tmp/file.txt' })).toStrictEqual({
      type: 'text', text: '<attached_file>\n{"name":"file.txt","path":"/tmp/file.txt"}\n</attached_file>', text_elements: [],
    });
    expect(attachmentInput({ type: 'file', path: '/tmp/file.txt', name: 'Notes' })).toStrictEqual({
      type: 'text', text: '<attached_file>\n{"name":"Notes","path":"/tmp/file.txt"}\n</attached_file>', text_elements: [],
    });
    expect(attachmentInput({ type: 'image', path: '/tmp/image.png' })).toStrictEqual({
      type: 'localImage', path: '/tmp/image.png',
    });
    expect(attachmentInput({ type: 'image', path: '/tmp/image.png', detail: 'original' })).toStrictEqual({
      type: 'localImage', path: '/tmp/image.png', detail: 'original',
    });
  });

  it('renders file and image attachment message parts', () => {
    expect(surfaceAttachmentPart({ type: 'file', path: '/tmp/file.txt', name: ' Notes ', mimeType: 'text/plain' }))
      .toStrictEqual({ type: 'attachment', attachment: {
        kind: 'file', name: 'Notes', path: '/tmp/file.txt', mimeType: 'text/plain',
      } });
    expect(surfaceAttachmentPart({ type: 'file', path: '/tmp/file.txt' })).toStrictEqual({
      type: 'attachment', attachment: { kind: 'file', name: 'file.txt', path: '/tmp/file.txt' },
    });
    expect(surfaceAttachmentPart({
      type: 'image', path: '/tmp/image.png', previewUrl: 'data:image/png;base64,AQ==', mimeType: 'image/png',
    })).toStrictEqual({ type: 'attachment', attachment: {
      kind: 'image', name: 'image.png', path: '/tmp/image.png',
      url: 'data:image/png;base64,AQ==', mimeType: 'image/png',
    } });
    expect(surfaceAttachmentPart({ type: 'image', path: '/tmp/image.png', name: 'Image' }))
      .toMatchObject({ attachment: { kind: 'image', name: 'Image', url: 'file:///tmp/image.png' } });
  });

  it('resolves turn identity from the direct field, metadata, or a precise absence', () => {
    const direct = surfaceMessage('direct', 'assistant', 'turn-direct');
    direct.metadata = { turnId: 'turn-metadata' };
    expect(messageTurnIdOrNull(direct)).toBe('turn-direct');

    const metadata = { ...surfaceMessage('metadata', 'assistant'), metadata: { turnId: 'turn-metadata' } };
    expect(messageTurnIdOrNull(metadata)).toBe('turn-metadata');
    expect(messageTurnId(metadata)).toBe('turn-metadata');

    const absent = surfaceMessage('absent', 'assistant');
    expect(messageTurnIdOrNull(absent)).toBeNull();
    expect(messageTurnIdOrNull({ ...absent, metadata: { turnId: 42 } })).toBeNull();
    expect(() => messageTurnId(absent)).toThrow('This message is not associated with a Codex turn');
  });

  it('extracts trimmed text while ignoring every non-text message part', () => {
    const message = surfaceMessage('mixed', 'assistant');
    message.parts = [
      { type: 'text', text: '  first ' },
      { type: 'status', text: 'ignored' },
      { type: 'text', text: ' second  ' },
      { type: 'attachment', attachment: { kind: 'file', name: 'file', path: '/file' } },
    ];
    expect(surfaceMessageText(message)).toBe('first \n second');
  });

  it('extracts renderer attachments and drops missing paths and unsafe image previews', () => {
    const message = surfaceMessage('attachments', 'user');
    message.parts = [
      { type: 'text', text: 'prompt' },
      { type: 'attachment', attachment: { kind: 'file', name: 'missing', path: '' } },
      { type: 'attachment', attachment: {
        kind: 'file', name: 'notes', path: '/notes.txt', mimeType: 'text/plain',
      } },
      { type: 'attachment', attachment: {
        kind: 'image', name: 'remote', path: '/remote.png', url: 'https://example.test/image.png',
      } },
      { type: 'attachment', attachment: {
        kind: 'image', name: 'inline', path: '/inline.png',
        url: 'data:image/png;base64,AQ==', mimeType: 'image/png',
      } },
    ];

    expect(surfaceMessageAttachments(message)).toStrictEqual([
      { type: 'file', path: '/notes.txt', name: 'notes', mimeType: 'text/plain' },
      { type: 'image', path: '/remote.png', name: 'remote' },
      {
        type: 'image', path: '/inline.png', name: 'inline', mimeType: 'image/png',
        previewUrl: 'data:image/png;base64,AQ==',
      },
    ]);
  });

  it('maps context usage and clamps percentages', () => {
    expect(surfaceContextUsage(tokenUsage(50, 200))).toMatchObject({ lastTotalTokens: 50, usedPercent: 25 });
    expect(surfaceContextUsage(tokenUsage(300, 200)).usedPercent).toBe(100);
    expect(surfaceContextUsage(tokenUsage(-10, 200)).usedPercent).toBe(0);
    expect(surfaceContextUsage(tokenUsage(10, null)).usedPercent).toBeNull();
    expect(surfaceContextUsage(tokenUsage(10, 0)).usedPercent).toBeNull();
  });

  it('maps thread and conversation statuses', () => {
    expect(surfaceThreadStatus({ type: 'active', activeFlags: ['waitingOnApproval'] })).toStrictEqual({
      type: 'active', activeFlags: ['waitingOnApproval'],
    });
    expect(surfaceThreadStatus({ type: 'idle' })).toStrictEqual({ type: 'idle' });
    expect(conversationStatus({ type: 'active', activeFlags: [] })).toBe('active');
    expect(conversationStatus({ type: 'systemError' })).toBe('error');
    expect(conversationStatus({ type: 'notLoaded' })).toBe('idle');
  });

  it('maps single and multi-bucket rate limit responses', () => {
    const codex = rateSnapshot({ limitId: 'codex', primary: { usedPercent: 20, windowDurationMins: 60, resetsAt: 10 } });
    expect(surfaceRateLimits({
      rateLimits: codex,
      rateLimitsByLimitId: { codex, missing: undefined },
      rateLimitResetCredits: { availableCount: 3, credits: [{ resetAt: 10, amount: '2' }] },
    } as unknown as v2.GetAccountRateLimitsResponse)).toMatchObject({
      rateLimits: { limitId: 'codex', primary: { usedPercent: 20 } },
      rateLimitsByLimitId: { codex: { limitId: 'codex' } },
      rateLimitResetCredits: { availableCount: '3', credits: [{ resetAt: 10, amount: '2' }] },
    });
    expect(surfaceRateLimits({
      rateLimits: rateSnapshot(), rateLimitsByLimitId: null,
      rateLimitResetCredits: { availableCount: 0, credits: null },
    } as unknown as v2.GetAccountRateLimitsResponse)).toMatchObject({
      rateLimitsByLimitId: null,
      rateLimitResetCredits: { availableCount: '0', credits: null },
    });
    expect(surfaceRateLimits({
      rateLimits: rateSnapshot(), rateLimitsByLimitId: null, rateLimitResetCredits: null,
      accountId: null, rateLimitUpsell: null, ordinaryUsageAllowed: null,
    }).rateLimitResetCredits).toBeNull();

    const individual = { limit: '10', used: '2', remainingPercent: 80, resetsAt: 10 };
    const mapped = surfaceRateLimits({
      rateLimits: rateSnapshot({ individualLimit: individual }),
      rateLimitsByLimitId: null,
      rateLimitResetCredits: null,
      accountId: null, ordinaryUsageAllowed: null,
      rateLimitUpsell: null,
    });
    expect(mapped.rateLimits.individualLimit).toStrictEqual(individual);
    expect(mapped.rateLimits.individualLimit).not.toBe(individual);
  });

  it('merges partial rate limit snapshots without erasing known fields', () => {
    const current = surfaceRateLimits({
      rateLimits: rateSnapshot({
        limitId: 'codex', limitName: 'Codex',
        primary: { usedPercent: 10, windowDurationMins: 60, resetsAt: 10 },
        credits: { hasCredits: true, unlimited: false, balance: '10' },
      }),
      rateLimitsByLimitId: null,
      rateLimitResetCredits: null,
      accountId: null, ordinaryUsageAllowed: null,
      rateLimitUpsell: null,
    });
    const merged = mergeSurfaceRateLimits(current, rateSnapshot({
      limitId: 'codex',
      primary: { usedPercent: 30, windowDurationMins: 60, resetsAt: 20 },
      secondary: { usedPercent: 5, windowDurationMins: 1_440, resetsAt: 30 },
    }));
    expect(merged).toMatchObject({
      rateLimits: {
        limitId: 'codex', limitName: 'Codex',
        primary: { usedPercent: 30, resetsAt: 20 },
        secondary: { usedPercent: 5 },
        credits: { balance: '10' },
      },
      rateLimitsByLimitId: { codex: { primary: { usedPercent: 30 } } },
    });

    expect(mergeSurfaceRateLimits(null, rateSnapshot({ limitId: 'codex' })).rateLimitsByLimitId)
      .toHaveProperty('codex');
    expect(mergeSurfaceRateLimits(null, rateSnapshot()).rateLimitsByLimitId).toBeNull();
    expect(mergeSurfaceRateLimits(current, rateSnapshot({ limitId: null })).rateLimitsByLimitId)
      .toHaveProperty('codex');
  });

  it('merges every snapshot sub-object and nullable identity field', () => {
    const current = surfaceRateLimitSnapshotFixture({
      primary: { usedPercent: 10 }, secondary: { usedPercent: 20 },
      credits: { balance: '1' }, individualLimit: { limit: '5' },
    });
    expect(mergeRateLimitSnapshot(current, surfaceRateLimitSnapshotFixture({
      limitId: 'new', limitName: 'New', primary: { resetsAt: 10 }, secondary: null,
      credits: { balance: '2' }, individualLimit: { used: '3' },
      planType: 'plus', rateLimitReachedType: 'primary',
    }))).toMatchObject({
      limitId: 'new', limitName: 'New',
      primary: { usedPercent: 10, resetsAt: 10 },
      secondary: { usedPercent: 20 },
      credits: { balance: '2' },
      individualLimit: { limit: '5', used: '3' },
      planType: 'plus', rateLimitReachedType: 'primary',
    });

    expect(mergeRateLimitSnapshot(current, surfaceRateLimitSnapshotFixture({
      secondary: { resetsAt: 30 }, credits: { hasCredits: true },
    }))).toMatchObject({
      secondary: { usedPercent: 20, resetsAt: 30 },
      credits: { balance: '1', hasCredits: true },
    });
  });

  it('preserves existing rate-limit buckets and keeps a truly empty map null', () => {
    const other = surfaceRateLimitSnapshotFixture({ limitId: 'other', limitName: 'Other' });
    const current = {
      rateLimits: surfaceRateLimitSnapshotFixture({ limitId: 'codex', limitName: 'Codex' }),
      rateLimitsByLimitId: { other },
      rateLimitResetCredits: null,
    };
    const merged = mergeSurfaceRateLimits(current, rateSnapshot({
      limitId: 'codex', primary: { usedPercent: 50, windowDurationMins: 60, resetsAt: 10 },
    }));
    expect(merged.rateLimitsByLimitId).toStrictEqual({
      other,
      codex: expect.objectContaining({ limitId: 'codex', primary: expect.objectContaining({ usedPercent: 50 }) }),
    });
    expect(merged.rateLimitsByLimitId).not.toBe(current.rateLimitsByLimitId);

    const empty = {
      rateLimits: surfaceRateLimitSnapshotFixture(),
      rateLimitsByLimitId: null,
      rateLimitResetCredits: null,
    };
    expect(mergeSurfaceRateLimits(empty, rateSnapshot()).rateLimitsByLimitId).toBeNull();
  });
});

function thread(overrides: Record<string, unknown> = {}): v2.Thread {
  return {
    id: 'thread-1', name: null, preview: ' First line\nsecond ', cwd: '/tmp',
    status: { type: 'idle' }, turns: [{ id: 'turn-1' }],
    createdAt: 1_767_225_601, updatedAt: 1_767_225_602, recencyAt: 1_767_225_603,
    ...overrides,
  } as unknown as v2.Thread;
}

function summary(id: string, updatedAt: string): CodexConversationSummary {
  return { id, title: id, preview: '', cwd: '/tmp', status: 'idle', turnCount: 0,
    createdAt: updatedAt, updatedAt };
}

function snapshot(models: CodexSurfaceModel[]): CodexSurfaceSnapshot {
  return { models, selectedModelId: models[0]?.id ?? null } as CodexSurfaceSnapshot;
}

function tokenUsage(lastTotalTokens: number, modelContextWindow: number | null): v2.ThreadTokenUsage {
  const total = {
    totalTokens: 100,
    inputTokens: 60,
    cachedInputTokens: 20,
    cacheWriteInputTokens: 0,
    outputTokens: 40,
    reasoningOutputTokens: 10,
  };
  return { total, last: { ...total, totalTokens: lastTotalTokens }, modelContextWindow };
}

function rateSnapshot(overrides: Partial<v2.RateLimitSnapshot> = {}): v2.RateLimitSnapshot {
  return {
    limitId: null, limitName: null, normalModelSlug: null, primary: null, secondary: null,
    credits: null, individualLimit: null, spendControlReached: null, planType: null, rateLimitReachedType: null,
    ...overrides,
  };
}

function surfaceRateLimitSnapshotFixture(
  overrides: Record<string, unknown> = {},
): CodexSurfaceRateLimitSnapshot {
  return {
    limitId: null, limitName: null, primary: null, secondary: null,
    credits: null, individualLimit: null, planType: null, rateLimitReachedType: null,
    ...overrides,
  } as CodexSurfaceRateLimitSnapshot;
}

function surfaceMessage(
  id: string,
  role: SurfaceMessage['role'],
  turnId?: string,
): SurfaceMessage {
  return {
    id, role, status: 'complete', parts: [],
    ...(turnId ? { turnId } : {}),
  };
}
