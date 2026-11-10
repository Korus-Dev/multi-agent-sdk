import { describe, expect, it, vi } from 'vitest';
import type { v2 } from '../../../codex-sdk/src/protocol';
import {
  boundedImageDataUrl,
  catalogIconMimeType,
  codexModelToSurfaceModel,
  firstLocalPluginIcon,
  safeRemoteImageUrl,
  surfacePlugin,
  surfaceSkill,
  surfaceSkills,
} from '../../src/providers/codex/codex-surface-catalog';

describe('Codex surface catalog codecs', () => {
  it('maps every model catalog field', () => {
    const model = { availableAccessPrograms: { cyber: [] },
      id: 'model-id',
      model: 'gpt-model',
      displayName: 'GPT Model',
      description: 'Description',
      hidden: false,
      supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'Medium' }],
      defaultReasoningEffort: 'medium',
      isDefault: true,
      inputModalities: ['text', 'image'],
      serviceTiers: [{ id: 'priority', name: 'Priority', description: 'Faster responses' }],
      supportsPersonality: true,
      upgrade: 'next-model',
      upgradeInfo: { message: 'Upgrade available' },
    } as unknown as v2.Model;

    expect(codexModelToSurfaceModel(model)).toStrictEqual({
      id: 'model-id',
      model: 'gpt-model',
      displayName: 'GPT Model',
      description: 'Description',
      hidden: false,
      supportedReasoningEfforts: model.supportedReasoningEfforts,
      defaultReasoningEffort: 'medium',
      serviceTiers: model.serviceTiers,
      isDefault: true,
      providerMetadata: {
        inputModalities: ['text', 'image'],
        serviceTiers: model.serviceTiers,
        supportsPersonality: true,
        upgrade: 'next-model',
        upgradeInfo: model.upgradeInfo,
      },
    });
  });

  it('omits empty model tiers and publishes an explicit default tier', () => {
    const base = { availableAccessPrograms: { cyber: [] },
      id: 'model-id', model: 'gpt-model', displayName: 'GPT Model', description: 'Description',
      hidden: false, supportedReasoningEfforts: [], defaultReasoningEffort: 'medium', isDefault: false,
      inputModalities: ['text'], supportsPersonality: false, upgrade: null, upgradeInfo: null,
    };
    const withoutTiers = codexModelToSurfaceModel({
      ...base, serviceTiers: [], defaultServiceTier: null,
    } as unknown as v2.Model);
    expect(withoutTiers).not.toHaveProperty('serviceTiers');
    expect(withoutTiers).not.toHaveProperty('defaultServiceTier');
    expect(withoutTiers.providerMetadata).toMatchObject({ serviceTiers: [] });

    expect(codexModelToSurfaceModel({
      ...base,
      serviceTiers: [{ id: 'priority', name: 'Priority', description: 'Fast' }],
      defaultServiceTier: 'priority',
    } as unknown as v2.Model)).toMatchObject({
      defaultServiceTier: 'priority',
      serviceTiers: [{ id: 'priority', name: 'Priority', description: 'Fast' }],
    });
  });

  it('filters disabled skills and resolves only declared icons', async () => {
    const loadIcon = vi.fn(async (path: string) => `data:${path}`);
    const enabled = skill({
      interface: {
        displayName: 'Commit and Push',
        shortDescription: 'Interface summary',
        iconSmall: '/icons/small.svg',
        iconLarge: '/icons/large.png',
        iconSmallUrl: null,
        iconLargeUrl: null,
        brandColor: '#00aaff',
        defaultPrompt: 'Ship it',
      },
    });
    const disabled = skill({ name: 'disabled', enabled: false });

    await expect(surfaceSkills([enabled, disabled], loadIcon)).resolves.toStrictEqual([{
      name: 'cp',
      description: 'Commit and push',
      shortDescription: 'Legacy summary',
      displayName: 'Commit and Push',
      iconSmall: 'data:/icons/small.svg',
      iconLarge: 'data:/icons/large.png',
      brandColor: '#00aaff',
      defaultPrompt: 'Ship it',
      path: '/skills/cp/SKILL.md',
      scope: 'user',
      enabled: true,
    }]);
    expect(loadIcon).toHaveBeenCalledTimes(2);

    await expect(surfaceSkill(skill({ shortDescription: undefined, interface: {
      shortDescription: 'Interface fallback',
      iconSmallUrl: null,
      iconLargeUrl: null,
    } }), loadIcon)).resolves.toMatchObject({
      shortDescription: 'Interface fallback',
      iconSmall: undefined,
      iconLarge: undefined,
    });
    await expect(surfaceSkill(skill({ shortDescription: undefined, interface: undefined }), loadIcon))
      .resolves.toMatchObject({ shortDescription: undefined, displayName: undefined });
  });

  it('normalizes provider skill brand colors to string-or-absent', async () => {
    const providerSkill = skill({
      interface: {
        displayName: 'Commit and Push',
        iconSmallUrl: null,
        iconLargeUrl: null,
        brandColor: null,
      },
    } as unknown as Partial<v2.SkillMetadata>);

    const withoutBrandColor = await surfaceSkill(providerSkill, async () => undefined);
    expect(withoutBrandColor).not.toHaveProperty('brandColor');

    await expect(surfaceSkill(skill({
      interface: {
        displayName: 'Commit and Push',
        iconSmallUrl: null,
        iconLargeUrl: null,
        brandColor: '  #00aaff  ',
      },
    }), async () => undefined)).resolves.toHaveProperty('brandColor', '#00aaff');

    for (const brandColor of ['', '   ', 42]) {
      const malformedProviderSkill = skill({
        interface: { brandColor },
      } as unknown as Partial<v2.SkillMetadata>);
      await expect(surfaceSkill(malformedProviderSkill, async () => undefined))
        .resolves.not.toHaveProperty('brandColor');
    }
  });

  it('normalizes provider skill default prompts to string-or-absent', async () => {
    for (const defaultPrompt of [null, 42, [], {}]) {
      const malformedProviderSkill = skill({
        interface: { defaultPrompt },
      } as unknown as Partial<v2.SkillMetadata>);
      const surfaced = await surfaceSkill(malformedProviderSkill, async () => undefined);
      expect(surfaced).not.toHaveProperty('defaultPrompt');

      await expect(surfaceSkills([malformedProviderSkill], async () => undefined))
        .resolves.toStrictEqual([surfaced]);
    }

    for (const exactPrompt of ['', '   ', '  Preserve this prompt exactly.  ']) {
      await expect(surfaceSkill(skill({
        interface: { iconSmallUrl: null, iconLargeUrl: null, defaultPrompt: exactPrompt },
      }), async () => undefined)).resolves.toHaveProperty('defaultPrompt', exactPrompt);
    }
  });

  it('prefers safe remote plugin art and omits blank optional metadata', async () => {
    const loadIcon = vi.fn(async () => 'data:local');
    const plugin = await surfacePlugin(pluginSummary({
      displayName: '  Gmail  ',
      shortDescription: '  Mail tools  ',
      longDescription: '  Long description  ',
      brandColor: '  #ff0000  ',
      composerIconUrl: 'https://cdn.example.com/composer.png',
      logoUrl: 'https://cdn.example.com/logo.png',
      logoUrlDark: 'https://cdn.example.com/dark.png',
    }), loadIcon);

    expect(plugin).toStrictEqual({
      id: 'plugin-1',
      name: 'gmail',
      displayName: 'Gmail',
      shortDescription: 'Mail tools',
      longDescription: 'Long description',
      brandColor: '#ff0000',
      iconUrl: 'https://cdn.example.com/composer.png',
      iconUrlDark: 'https://cdn.example.com/composer.png',
      enabled: true,
    });
    expect(loadIcon).not.toHaveBeenCalled();

    await expect(surfacePlugin(pluginSummary({
      displayName: ' ',
      shortDescription: ' ',
      longDescription: null,
      brandColor: null,
    }), loadIcon)).resolves.toStrictEqual({
      id: 'plugin-1',
      name: 'gmail',
      displayName: 'gmail',
      iconUrl: 'data:local',
      iconUrlDark: 'data:local',
      enabled: true,
    });
  });

  it('falls back across local light and dark plugin icons', async () => {
    const loadIcon = vi.fn(async (path: string) => (
      path.endsWith('logo.svg') ? `data:${path}` : undefined
    ));
    const plugin = await surfacePlugin(pluginSummary({
      composerIcon: '/icons/missing.svg',
      logo: '/icons/logo.svg',
      logoDark: '/icons/dark-missing.svg',
      composerIconUrl: 'http://unsafe.example/icon.png',
      logoUrl: 'not a url',
      logoUrlDark: null,
    }), loadIcon);
    expect(plugin).toMatchObject({
      iconUrl: 'data:/icons/logo.svg',
      iconUrlDark: 'data:/icons/logo.svg',
    });
    expect(loadIcon.mock.calls.map(([path]) => path)).toStrictEqual([
      '/icons/missing.svg',
      '/icons/logo.svg',
      '/icons/missing.svg',
      '/icons/dark-missing.svg',
      '/icons/logo.svg',
    ]);

    await expect(firstLocalPluginIcon([null, undefined, '/missing'], async () => undefined))
      .resolves.toBeUndefined();
  });

  it('uses plugin identity defaults when interface metadata is absent', async () => {
    const loadIcon = vi.fn(async () => 'unused');
    await expect(surfacePlugin({
      id: 'plugin-minimal', name: 'minimal', enabled: false, interface: undefined,
    } as unknown as v2.PluginSummary, loadIcon)).resolves.toStrictEqual({
      id: 'plugin-minimal',
      name: 'minimal',
      displayName: 'minimal',
      enabled: false,
    });
    expect(loadIcon).not.toHaveBeenCalled();
  });

  it.each([
    ['https://example.com/icon.png', 'https://example.com/icon.png'],
    ['  https://example.com/icon.png  ', 'https://example.com/icon.png'],
    ['http://example.com/icon.png', undefined],
    ['file:///tmp/icon.png', undefined],
    ['not a url', undefined],
    [' ', undefined],
    [null, undefined],
    [undefined, undefined],
  ])('accepts only remote HTTPS image URLs %#', (value, expected) => {
    expect(safeRemoteImageUrl(value)).toBe(expected);
  });

  it.each([
    ['icon.avif', 'image/avif'],
    ['icon.BMP', 'image/bmp'],
    ['icon.gif', 'image/gif'],
    ['icon.ico', 'image/x-icon'],
    ['icon.jpeg', 'image/jpeg'],
    ['icon.jpg', 'image/jpeg'],
    ['icon.png', 'image/png'],
    ['icon.svg', 'image/svg+xml'],
    ['icon.webp', 'image/webp'],
    ['icon.txt', undefined],
    ['icon', undefined],
  ])('recognizes catalog icon MIME type for %s', (path, expected) => {
    expect(catalogIconMimeType(path)).toBe(expected);
  });

  it('validates, normalizes, and bounds image base64 data', () => {
    expect(boundedImageDataUrl('image/png', ' AQIDBA== ')).toBe('data:image/png;base64,AQIDBA==');
    expect(boundedImageDataUrl('image/png', 'AQI')).toBe('data:image/png;base64,AQI=');
    expect(boundedImageDataUrl('image/png', 'AQI=')).toBe('data:image/png;base64,AQI=');
    expect(boundedImageDataUrl('image/png', '')).toBeUndefined();
    expect(boundedImageDataUrl('image/png', '%%%')).toBeUndefined();
    expect(boundedImageDataUrl('image/png', '!AQI')).toBeUndefined();
    expect(boundedImageDataUrl('image/png', 'AQI!')).toBeUndefined();
    expect(boundedImageDataUrl('image/png', 'A')).toBeUndefined();
    expect(boundedImageDataUrl('image/png', 'AQI==')).toBeUndefined();
    const atLimit = Buffer.alloc(256 * 1024).toString('base64');
    const overLimit = Buffer.alloc(256 * 1024 + 1).toString('base64');
    expect(boundedImageDataUrl('image/png', atLimit)).toBe(`data:image/png;base64,${atLimit}`);
    expect(boundedImageDataUrl('image/png', overLimit)).toBeUndefined();
  });
});

function skill(overrides: Partial<v2.SkillMetadata> = {}): v2.SkillMetadata {
  return {
    name: 'cp',
    description: 'Commit and push',
    shortDescription: 'Legacy summary',
    path: '/skills/cp/SKILL.md',
    scope: 'user',
    enabled: true,
    pluginId: null,
    ...overrides,
  };
}

function pluginSummary(interfaceOverrides: Partial<v2.PluginInterface>): v2.PluginSummary {
  return {
    id: 'plugin-1',
    name: 'gmail',
    enabled: true,
    interface: {
      displayName: 'Gmail',
      shortDescription: null,
      longDescription: null,
      developerName: null,
      category: null,
      capabilities: [],
      websiteUrl: null,
      privacyPolicyUrl: null,
      termsOfServiceUrl: null,
      defaultPrompt: null,
      brandColor: null,
      composerIcon: '/icons/composer.svg',
      composerIconUrl: null,
      logo: '/icons/logo.svg',
      logoDark: '/icons/logo-dark.svg',
      logoUrl: null,
      logoUrlDark: null,
      screenshots: [],
      screenshotUrls: [],
      ...interfaceOverrides,
    },
  } as unknown as v2.PluginSummary;
}
