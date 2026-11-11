import type { AccountRateLimits, HarnessProvider, AgentContextUsage, AgentFileActivity, ProviderModelOption, ProviderRuntimeStatus, ProviderSkillSummary, ClaudeConversationEvent, ClaudeConversationSnapshot, CursorConversationEvent, CursorConversationSnapshot, AntigravityConversationEvent, AntigravityConversationSnapshot, SubagentActivityChange, SubagentIdentityChange, SubagentOperationChange, SubagentStatusChange, ThreadGoal } from './index';
import type { AgentStatus } from './status';
import type { DevicePairingStatus } from './remote-control';
import type { TurnGitDiff } from './turn-diff';
import type { ConversationSettings } from './conversation-settings';
import type { CodexConversationEvent, CodexConversationSnapshot } from '../core/codex-conversation-types';
type EventEnvelope = { seq?: number; source?: 'provider' | 'client'; agentId?: string; provider?: HarnessProvider; providerSessionId?: string; conversationId?: string; threadId?: string; turnId?: string; occurredAt?: string };
type EventWith<Variant> = EventEnvelope & Variant;
type AgentUpdatedPayload = { id: string; conversationTitle?: string };
type ThreadMode = 'default' | 'plan';
type ThreadTurnEventContext = { agentId: string; provider: HarnessProvider; turnId: string };
export type ProviderEvent =
  | EventWith<{ type: 'cursor.conversationSnapshotChanged'; agentId: string; provider: 'cursor'; payload: { revision: number; snapshot: CursorConversationSnapshot } }>
  | EventWith<{ type: 'cursor.conversationEventReceived'; agentId: string; provider: 'cursor'; payload: { revision: number; event: CursorConversationEvent } }>
  | EventWith<{ type: 'antigravity.conversationSnapshotChanged'; agentId: string; provider: 'antigravity'; payload: { revision: number; snapshot: AntigravityConversationSnapshot } }>
  | EventWith<{ type: 'antigravity.conversationEventReceived'; agentId: string; provider: 'antigravity'; payload: { revision: number; event: AntigravityConversationEvent } }>
  | EventWith<{
      type: 'provider.authenticationChanged';
      payload: import('./authentication').ProviderAuthentication;
    }>
  | EventWith<{
      type: 'provider.statusChanged';
      provider: HarnessProvider;
      payload: ProviderRuntimeStatus;
    }>
  | EventWith<{
      type: 'account.rateLimitsUpdated';
      provider: HarnessProvider;
      payload: { rateLimits: AccountRateLimits };
    }>
  | EventWith<{
      type: 'remoteControl.statusChanged';
      payload: DevicePairingStatus;
    }>
  | EventWith<{
      type: 'models.changed';
      provider: HarnessProvider;
      payload: { models: ProviderModelOption[] };
    }>
  | EventWith<{
      type: 'skills.changed';
      provider: HarnessProvider;
      payload: {
        cwd: string | null;
        status: 'loaded';
        skills: ProviderSkillSummary[];
      };
    }>
  | EventWith<{
      type: 'codex.conversationSnapshotChanged';
      agentId: string;
      provider: 'codex';
      threadId: string;
      payload: {
        revision: number;
        snapshot: CodexConversationSnapshot;
      };
    }>
  | EventWith<{
      type: 'codex.conversationEventReceived';
      agentId: string;
      provider: 'codex';
      threadId: string;
      payload: {
        revision: number;
        event: CodexConversationEvent;
      };
    }>
  | EventWith<{
      type: 'claude.conversationSnapshotChanged';
      agentId: string;
      provider: 'claude';
      payload: {
        revision: number;
        snapshot: ClaudeConversationSnapshot;
      };
    }>
  | EventWith<{
      type: 'claude.conversationEventReceived';
      agentId: string;
      provider: 'claude';
      payload: {
        revision: number;
        event: ClaudeConversationEvent;
      };
    }>
  | EventWith<{
      type: 'plan.readyForReview';
      agentId: string;
      turnId: string;
      payload: { markdown: string; itemId?: string; requestId?: string };
    }>
  | EventWith<{
      type: 'agent.updated';
      agentId: string;
      payload: AgentUpdatedPayload;
    }>
  | EventWith<{
      type: 'agent.statusChanged';
      agentId: string;
      payload: AgentStatus;
    }>
  | EventWith<{
      type: 'agent.conversationAttached';
      agentId: string;
      provider: HarnessProvider;
      conversationId: string;
      payload: { cwd?: string };
    }>
  | EventWith<{
      type: 'conversation.settingsUpdated';
      agentId: string;
      provider: HarnessProvider;
      payload: { settings: ConversationSettings };
    }>
  | EventWith<{
      type: 'conversation.modeUpdated';
      agentId: string;
      provider: HarnessProvider;
      payload: { mode: ThreadMode; permissionMode?: string };
    }>
  | EventWith<{
      type: 'conversation.goalUpdated';
      agentId: string;
      payload: { goal: ThreadGoal };
    }>
  | EventWith<{
      type: 'conversation.goalCleared';
      agentId: string;
      payload: Record<string, never>;
    }>
  | EventWith<{
      type: 'conversation.contextUsageUpdated';
      agentId: string;
      provider: HarnessProvider;
      payload: { contextUsage: AgentContextUsage };
    }>
  | EventWith<{
      type: 'subagent.operationChanged';
      agentId: string;
      provider: HarnessProvider;
      payload: SubagentOperationChange;
    }>
  | EventWith<{
      type: 'subagent.activityChanged';
      agentId: string;
      provider: HarnessProvider;
      payload: SubagentActivityChange;
    }>
  | EventWith<{
      type: 'subagent.identityChanged';
      agentId: string;
      provider: HarnessProvider;
      payload: SubagentIdentityChange;
    }>
  | EventWith<{
      type: 'subagent.statusChanged';
      agentId: string;
      provider: HarnessProvider;
      payload: SubagentStatusChange;
    }>
  | EventWith<ThreadTurnEventContext & {
      type: 'conversation.turnDiffUpdated';
      payload: Omit<TurnGitDiff, 'agentId' | 'turnId' | 'updatedAt'>;
    }>
  | EventWith<ThreadTurnEventContext & {
      type: 'workspace.fileActivityDetected';
      payload: Omit<AgentFileActivity, 'agentId' | 'turnId' | 'occurredAt'>;
    }>
  | EventWith<{
      type: 'agentRequest.created';
      agentId: string;
      provider: HarnessProvider;
      turnId?: string;
      payload: { request: import('../conversations/agent-request').AgentRequest };
    }>
  | EventWith<{
      type: 'agentRequest.resolved';
      agentId: string;
      provider: HarnessProvider;
      turnId?: string;
      payload: {
        id: string;
        outcome: import('../conversations/agent-request').AgentRequestOutcome;
      };
    }>;
