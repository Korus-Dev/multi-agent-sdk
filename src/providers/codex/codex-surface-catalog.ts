import { extname } from 'node:path';
import type { v2 } from 'codex-sdk';
import type { CodexSurfaceModel, CodexSurfacePlugin, CodexSurfaceSkill } from '../../core/surface';

const MAX_CATALOG_ICON_BYTES = 256 * 1024;

export function codexModelToSurfaceModel(model: v2.Model): CodexSurfaceModel {
  return {
    id: model.id,
    model: model.model,
    displayName: model.displayName,
    description: model.description,
    hidden: model.hidden,
    supportedReasoningEfforts: model.supportedReasoningEfforts,
    defaultReasoningEffort: model.defaultReasoningEffort,
    ...(model.serviceTiers.length > 0 ? {
      serviceTiers: model.serviceTiers.map((tier) => ({
        id: tier.id,
        name: tier.name,
        description: tier.description,
      })),
    } : {}),
    ...(model.defaultServiceTier ? { defaultServiceTier: model.defaultServiceTier } : {}),
    isDefault: model.isDefault,
    providerMetadata: {
      inputModalities: model.inputModalities,
      serviceTiers: model.serviceTiers,
      supportsPersonality: model.supportsPersonality,
      upgrade: model.upgrade,
      upgradeInfo: model.upgradeInfo,
    },
  };
}

export async function surfaceSkills(
  skills: readonly v2.SkillMetadata[],
  localIconDataUrl: (path: string) => Promise<string | undefined>,
): Promise<CodexSurfaceSkill[]> {
  return Promise.all(
    skills
      .filter((skill) => skill.enabled)
      .map((skill) => surfaceSkill(skill, localIconDataUrl)),
  );
}

export async function surfaceSkill(
  skill: v2.SkillMetadata,
  localIconDataUrl: (path: string) => Promise<string | undefined>,
): Promise<CodexSurfaceSkill> {
  const brandColor = nonEmpty(skill.interface?.brandColor);
  const defaultPrompt = stringOrUndefined(skill.interface?.defaultPrompt);
  const [iconSmall, iconLarge] = await Promise.all([
    skill.interface?.iconSmall ? localIconDataUrl(skill.interface.iconSmall) : undefined,
    skill.interface?.iconLarge ? localIconDataUrl(skill.interface.iconLarge) : undefined,
  ]);
  return {
    name: skill.name,
    description: skill.description,
    shortDescription: skill.shortDescription ?? skill.interface?.shortDescription,
    displayName: skill.interface?.displayName,
    iconSmall,
    iconLarge,
    ...(brandColor ? { brandColor } : {}),
    ...(defaultPrompt !== undefined ? { defaultPrompt } : {}),
    path: skill.path,
    scope: skill.scope,
    enabled: skill.enabled,
  };
}

export async function surfacePlugin(
  plugin: v2.PluginSummary,
  localIconDataUrl: (path: string) => Promise<string | undefined>,
): Promise<CodexSurfacePlugin> {
  const pluginInterface = plugin.interface;
  const composerIconUrl = safeRemoteImageUrl(pluginInterface?.composerIconUrl);
  const logoUrl = safeRemoteImageUrl(pluginInterface?.logoUrl);
  const logoUrlDark = safeRemoteImageUrl(pluginInterface?.logoUrlDark);
  const displayName = nonEmpty(pluginInterface?.displayName) ?? plugin.name;
  const shortDescription = nonEmpty(pluginInterface?.shortDescription);
  const longDescription = nonEmpty(pluginInterface?.longDescription);
  const brandColor = nonEmpty(pluginInterface?.brandColor);
  const iconUrl = composerIconUrl
    ?? logoUrl
    ?? await firstLocalPluginIcon([pluginInterface?.composerIcon, pluginInterface?.logo], localIconDataUrl);
  const iconUrlDark = composerIconUrl
    ?? logoUrlDark
    ?? logoUrl
    ?? await firstLocalPluginIcon([
      pluginInterface?.composerIcon,
      pluginInterface?.logoDark,
      pluginInterface?.logo,
    ], localIconDataUrl);
  return {
    id: plugin.id,
    name: plugin.name,
    displayName,
    ...(shortDescription ? { shortDescription } : {}),
    ...(longDescription ? { longDescription } : {}),
    ...(brandColor ? { brandColor } : {}),
    ...(iconUrl ? { iconUrl } : {}),
    ...(iconUrlDark ? { iconUrlDark } : {}),
    enabled: plugin.enabled,
  };
}

export async function firstLocalPluginIcon(
  paths: readonly (string | null | undefined)[],
  localIconDataUrl: (path: string) => Promise<string | undefined>,
): Promise<string | undefined> {
  for (const path of paths) {
    if (!path) continue;
    const dataUrl = await localIconDataUrl(path);
    if (dataUrl) return dataUrl;
  }
  return undefined;
}

export function safeRemoteImageUrl(value: string | null | undefined): string | undefined {
  const url = nonEmpty(value);
  try {
    return new URL(url!).protocol === 'https:' ? url : undefined;
  } catch {}
  return undefined;
}

export function catalogIconMimeType(path: string): string | undefined {
  switch (extname(path).toLowerCase()) {
    case '.avif': return 'image/avif';
    case '.bmp': return 'image/bmp';
    case '.gif': return 'image/gif';
    case '.ico': return 'image/x-icon';
    case '.jpeg':
    case '.jpg': return 'image/jpeg';
    case '.png': return 'image/png';
    case '.svg': return 'image/svg+xml';
    case '.webp': return 'image/webp';
  }
  return undefined;
}

export function boundedImageDataUrl(mimeType: string, dataBase64: string): string | undefined {
  const encoded = dataBase64.trim();
  if (!/^[a-z\d+/]+={0,2}$/i.test(encoded)) {
    return undefined;
  }
  const unpadded = encoded.replace(/=+$/, '');
  if (unpadded.length % 4 === 1) return undefined;
  const suppliedPadding = encoded.length - unpadded.length;
  const requiredPadding = (4 - (unpadded.length % 4)) % 4;
  if (suppliedPadding !== 0 && suppliedPadding !== requiredPadding) return undefined;
  const byteLength = Math.floor((unpadded.length * 3) / 4);
  if (byteLength > MAX_CATALOG_ICON_BYTES) return undefined;
  const padded = `${unpadded}${'='.repeat((4 - (unpadded.length % 4)) % 4)}`;
  return `data:${mimeType};base64,${padded}`;
}

function nonEmpty(value: unknown): string | undefined {
  const trimmed = typeof value === 'string' ? value.trim() : undefined;
  return trimmed || undefined;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
