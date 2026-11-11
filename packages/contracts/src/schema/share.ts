import { z } from 'zod/v4';
import { TextRefSchema } from './run.js';

export const ShareSelectionSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('all') }),
  z.object({ mode: z.literal('recent'), count: z.number().int().min(1).max(1000) }),
  z.object({ mode: z.literal('selected'), turnIds: z.array(z.string().min(1).max(500)).min(1).max(1000), nativeChatId: z.string().min(1).max(500).optional() }),
]);
export const ShareAppearanceRequestSchema = z.object({
  themeId: z.string().min(1).max(100),
  mode: z.enum(['system', 'light', 'dark']),
  themeRevision: z.string().min(1).max(100).optional(),
  uiFont: z.string().min(1).max(160).optional(),
  monoFont: z.string().min(1).max(160).optional(),
  background: z.string().min(1).max(160).optional(),
});
export const ShareDraftRequestSchema = z.object({ selection: ShareSelectionSchema.optional(), appearance: ShareAppearanceRequestSchema.optional(), author: z.boolean().optional() });
const SharePublisherInfoSchema = z.object({ id: z.string(), label: z.string(), audience: z.string() });
export const ShareCapabilitySchema = z.object({
  available: z.boolean(),
  reason: z.enum(['missing_cli', 'unsupported_cli', 'login_required', 'permission_denied', 'unavailable']).optional(),
  message: z.string().optional(), username: z.string().optional(), profile: z.string().optional(),
  publisher: SharePublisherInfoSchema.optional(),
  publishers: z.array(SharePublisherInfoSchema).optional(),
});
export const SessionShareSchema = z.object({
  id: z.string(), sessionId: z.string(), title: z.string(), alias: z.string(), username: z.string(),
  profile: z.string().optional(), publisher: z.string().optional(), url: z.string().optional(),
  previewId: z.string().optional(), deploymentId: z.string().optional(), capturedAt: z.string().optional(),
  expiresAt: z.string().optional(), publishedHash: z.string().optional(), appearance: ShareAppearanceRequestSchema.optional(), author: z.boolean().optional(),
  state: z.enum(['unpublished', 'published', 'removed']), operation: z.enum(['publishing', 'removing', 'uncertain']).optional(),
  error: z.string().optional(), errorRef: TextRefSchema.optional(), updatedAt: z.string(),
});
export const ShareStatusSchema = z.object({
  capability: ShareCapabilitySchema, share: SessionShareSchema.nullable(),
  blocker: z.object({ code: z.string(), message: z.string(), messageRef: TextRefSchema.optional() }).optional(),
  actions: z.object({ preview: z.boolean(), publish: z.boolean(), remove: z.boolean(), reconcile: z.boolean(), retry: z.boolean() }),
});
export const ShareDraftSchema = z.object({
  id: z.string(), sessionId: z.string(), capturedAt: z.string(), previewUrl: z.string(),
  warnings: z.array(z.string()), warningRefs: z.array(TextRefSchema).optional(), bytes: z.number(),
  appearance: ShareAppearanceRequestSchema.optional(), author: z.boolean().optional(),
});
export const ShareTurnCatalogSchema = z.object({
  turns: z.array(z.object({ id: z.string(), text: z.string(), createdAt: z.string() })), nativeChatId: z.string().optional(),
});
export const ShareDraftEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('progress'), progress: z.object({ stage: z.enum(['auth', 'history', 'assets', 'resources', 'finalizing']) }) }),
  z.object({ type: z.literal('ready'), draft: ShareDraftSchema }),
  z.object({ type: z.literal('error'), message: z.string(), messageRef: TextRefSchema.optional() }),
]);
