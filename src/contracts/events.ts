import type { AccountRateLimits, AgentBackend, AgentContextUsage, AgentFileActivity, BackendModelOption, BackendRuntimeStatus, BackendSkillSummary, ClaudeConversationEvent, ClaudeConversationSnapshot, CursorConversationEvent, CursorConversationSnapshot, AntigravityConversationEvent, AntigravityConversationSnapshot, SubagentActivityChange, SubagentIdentityChange, SubagentOperationChange, SubagentStatusChange, ThreadGoal } from './index';
import type { AgentStatus } from './status';
import type { DevicePairingStatus } from './remote-control';
import type { TurnGitDiff } from './turn-diff';
import type { ConversationSettings } from './conversation-settings';
import type { CodexConversationEvent, CodexConversationSnapshot } from '../core/surface';
type EventEnvelope = { seq?: number; source?: 'backend' | 'client'; agentId?: string; backend?: AgentBackend; backendSessionId?: string; conversationId?: string; threadId?: string; turnId?: string; occurredAt?: string };
type EventWith<Variant> = EventEnvelope & Variant;
type AgentUpdatedPayload = { id: string; conversationTitle?: string };
type ThreadMode = 'default' | 'plan';
type ThreadTurnEventContext = { agentId: string; backend: AgentBackend; turnId: string };
export type HarnessEvent =
  | EventWith<{ type: 'cursor.conversationSnapshotChanged'; agentId: string; backend: 'cursor'; payload: { revision: number; snapshot: CursorConversationSnapshot } }>
  | EventWith<{ type: 'cursor.conversationEventReceived'; agentId: string; backend: 'cursor'; payload: { revision: number; event: CursorConversationEvent } }>
  | EventWith<{ type: 'antigravity.conversationSnapshotChanged'; agentId: string; backend: 'antigravity'; payload: { revision: number; snapshot: AntigravityConversationSnapshot } }>
  | EventWith<{ type: 'antigravity.conversationEventReceived'; agentId: string; backend: 'antigravity'; payload: { revision: number; event: AntigravityConversationEvent } }>
  | EventWith<{
      type: 'provider.authenticationChanged';
      payload: import('./authentication').ProviderAuthentication;
    }>
  | EventWith<{
      type: 'backend.statusChanged';
      backend: AgentBackend;
      payload: BackendRuntimeStatus;
    }>
  | EventWith<{
      type: 'account.rateLimitsUpdated';
      backend: AgentBackend;
      payload: { rateLimits: AccountRateLimits };
    }>
  | EventWith<{
      type: 'remoteControl.statusChanged';
      payload: DevicePairingStatus;
    }>
  | EventWith<{
      type: 'models.changed';
      backend: AgentBackend;
      payload: { models: BackendModelOption[] };
    }>
  | EventWith<{
      type: 'skills.changed';
      backend: AgentBackend;
      payload: {
        cwd: string | null;
        status: 'loaded';
        skills: BackendSkillSummary[];
      };
    }>
  | EventWith<{
      type: 'codex.conversationSnapshotChanged';
      agentId: string;
      backend: 'codex';
      threadId: string;
      payload: {
        revision: number;
        snapshot: CodexConversationSnapshot;
      };
    }>
  | EventWith<{
      type: 'codex.conversationEventReceived';
      agentId: string;
      backend: 'codex';
      threadId: string;
      payload: {
        revision: number;
        event: CodexConversationEvent;
      };
    }>
  | EventWith<{
      type: 'claude.conversationSnapshotChanged';
      agentId: string;
      backend: 'claude';
      payload: {
        revision: number;
        snapshot: ClaudeConversationSnapshot;
      };
    }>
  | EventWith<{
      type: 'claude.conversationEventReceived';
      agentId: string;
      backend: 'claude';
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
      backend: AgentBackend;
      conversationId: string;
      payload: { cwd?: string };
    }>
  | EventWith<{
      type: 'conversation.settingsUpdated';
      agentId: string;
      backend: AgentBackend;
      payload: { settings: ConversationSettings };
    }>
  | EventWith<{
      type: 'conversation.modeUpdated';
      agentId: string;
      backend: AgentBackend;
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
      backend: AgentBackend;
      payload: { contextUsage: AgentContextUsage };
    }>
  | EventWith<{
      type: 'subagent.operationChanged';
      agentId: string;
      backend: AgentBackend;
      payload: SubagentOperationChange;
    }>
  | EventWith<{
      type: 'subagent.activityChanged';
      agentId: string;
      backend: AgentBackend;
      payload: SubagentActivityChange;
    }>
  | EventWith<{
      type: 'subagent.identityChanged';
      agentId: string;
      backend: AgentBackend;
      payload: SubagentIdentityChange;
    }>
  | EventWith<{
      type: 'subagent.statusChanged';
      agentId: string;
      backend: AgentBackend;
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
      backend: AgentBackend;
      turnId?: string;
      payload: { request: import('../conversations/agent-request').AgentRequest };
    }>
  | EventWith<{
      type: 'agentRequest.resolved';
      agentId: string;
      backend: AgentBackend;
      turnId?: string;
      payload: {
        id: string;
        outcome: import('../conversations/agent-request').AgentRequestOutcome;
      };
    }>;
