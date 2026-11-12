import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { AcpConnection, record } from '../../acp/acp-connection';
import type { ProviderModelOption } from '../../contracts/index';

export type AcpCatalogEntry = { sessionId: string; cwd: string; title: string; updatedAt: string };

export async function listAcpSessions(connection: AcpConnection): Promise<AcpCatalogEntry[]> {
  const result = await connection.request('session/list', {});
  if (!record(result) || !Array.isArray(result.sessions) || result.sessions.length > 10_000) throw new Error('Invalid Antigravity session catalog.');
  return result.sessions.map(value => {
    if (!record(value) || typeof value.sessionId !== 'string' || !value.sessionId || typeof value.cwd !== 'string' || !path.isAbsolute(value.cwd)) throw new Error('Invalid Antigravity session catalog entry.');
    return { sessionId: value.sessionId, cwd: value.cwd, title: typeof value.title === 'string' ? value.title : '', updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : '' };
  });
}

export async function validateAcpSession(connection: AcpConnection, sessionId: string, cwd: string): Promise<void> {
  const entry = (await listAcpSessions(connection)).find(candidate => candidate.sessionId === sessionId);
  if (!entry || await realpath(entry.cwd).catch(() => null) !== await realpath(cwd)) throw new Error('Antigravity conversation is missing or belongs to another workspace.');
}

/**
 * The models a session offers. The CLI lists the models to choose from and, separately, how hard the selected one
 * thinks; a model takes a thinking level when the CLI also lists it at each level.
 */
export function antigravityModels(configuration: Record<string, unknown>): ProviderModelOption[] {
  const options = Array.isArray(configuration.configOptions) ? configuration.configOptions.filter(record) : [];
  const choices = (id: string) => { const option = options.find(candidate => candidate.id === id); return { current: option?.currentValue, values: Array.isArray(option?.options) ? option.options.filter(record) : [] }; };
  const models = choices('model'), levels = choices('thought_level');
  const available = record(configuration.models) && Array.isArray(configuration.models.availableModels)
    ? configuration.models.availableModels.filter(record).flatMap(model => typeof model.modelId === 'string' ? [model.modelId] : []) : [];
  // An older CLI lists every model and level as one flat list.
  if (!models.values.length) return (record(configuration.models) && Array.isArray(configuration.models.availableModels) ? configuration.models.availableModels.filter(record) : [])
    .flatMap(model => typeof model.modelId === 'string' ? [{ id: model.modelId, model: model.modelId, displayName: typeof model.name === 'string' ? model.name : model.modelId,
      isDefault: model.modelId === (configuration.models as Record<string, unknown>).currentModelId }] : []);
  return models.values.filter(model => typeof model.value === 'string').map(model => {
    const id = model.value as string;
    const efforts = levels.values.flatMap(level => typeof level.value === 'string' && available.includes(`${id}-${level.value}`)
      ? [{ reasoningEffort: level.value, description: typeof level.name === 'string' ? level.name : level.value }] : []);
    return { id, model: id, displayName: typeof model.name === 'string' ? model.name : id,
      ...(typeof model.description === 'string' ? { description: model.description } : {}),
      ...(efforts.length ? { supportedReasoningEfforts: efforts, defaultReasoningEffort: typeof levels.current === 'string' ? levels.current : efforts[0]!.reasoningEffort } : {}),
      isDefault: id === models.current };
  });
}
