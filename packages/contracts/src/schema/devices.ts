/*
 * The device channel's wire contracts (docs/DEVICES.md §3), mirroring the `Device*` interfaces in
 * `packages/contracts/src/index.ts`. Platform and capability ids are open: a newer server or device
 * may name one the other side does not know yet, which it ignores rather than fail on.
 */
import { z } from 'zod/v4';
import { ASSISTANT_QUERY_BUDGET, WORKBENCH_APPEARANCE_BUDGET } from '../budgets.js';
import { DEVICE_CAPABILITIES } from '../devices.js';

export const DevicePlatformSchema = z.enum(['android', 'ios', 'mac']).meta({ open: true });
export const DeviceCapabilitySchema = z.enum(DEVICE_CAPABILITIES).meta({ open: true });

export const DeviceAppearanceRequestSchema = z.strictObject({
  themeId: z.string().min(1).max(120).optional(),
  mode: z.enum(['system', 'light', 'dark']).optional(),
  interfaceStyle: z.string().min(1).max(120).optional(),
});
const AppearanceOption = z.object({ id: z.string().min(1).max(120), name: z.string().min(1).max(120) });
export const DeviceAppearanceResultSchema = z.object({
  themeId: z.string().min(1).max(120),
  mode: z.enum(['system', 'light', 'dark']),
  interfaceStyle: z.string().min(1).max(120).optional(),
  activePaletteId: z.string().min(1).max(120).optional(),
  themes: z.array(AppearanceOption).max(WORKBENCH_APPEARANCE_BUDGET.themes),
  interfaceStyles: z.array(AppearanceOption).max(ASSISTANT_QUERY_BUDGET.pageItems).optional(),
});

/** APNs device and Live Activity tokens are hex; the server checks the format (`DeviceChannel.report`). */
const ApnsTokenSchema = z.string().max(400);
export const DevicePushRegistrationSchema = z.object({
  token: ApnsTokenSchema,
  topic: z.string().max(155),
  environment: z.enum(['production', 'sandbox']),
  activityStartToken: ApnsTokenSchema.optional(),
  activityToken: ApnsTokenSchema.optional(),
});
export const DeviceReportSchema = z.object({
  platform: DevicePlatformSchema,
  appVersion: z.string().max(64),
  capabilities: z.array(DeviceCapabilitySchema).max(64),
  allowControl: z.boolean(),
  installationId: z.string().max(100).regex(/^[A-Za-z0-9-]+$/).optional(),
  push: DevicePushRegistrationSchema.nullable().optional(),
});
export const DevicePushRouteSchema = z.object({
  route: z.enum(['direct', 'none']).meta({ open: true }),
  reason: z.enum(['no_key', 'no_token', 'failed']).meta({ open: true }).optional(),
  detail: z.string().optional(),
});
export const DeviceInfoSchema = z.object({
  id: z.string(), name: z.string(), platform: DevicePlatformSchema.optional(), appVersion: z.string().optional(),
  createdAt: z.string(), lastSeenAt: z.string().optional(),
  online: z.boolean(), capabilities: z.array(DeviceCapabilitySchema), allowControl: z.boolean(),
  push: DevicePushRouteSchema.optional(), verificationCode: z.string().optional(),
});
export const DeviceCallSchema = z.object({
  callId: z.string(), sessionId: z.string(), capability: DeviceCapabilitySchema,
  args: z.record(z.string(), z.unknown()), deadline: z.string(), createdAt: z.string(),
});
export const DeviceCallOutcomeSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), result: z.record(z.string(), z.unknown()) }),
  z.object({ ok: z.literal(false), code: z.string().min(1).max(100), message: z.string().max(2000).optional() }),
]);
export const DeviceCallReceiptSchema = z.object({ callId: z.string(), outcome: DeviceCallOutcomeSchema, receivedAt: z.string() });
export const DeviceFileSchema = z.object({ fileId: z.string(), name: z.string(), mimeType: z.string(), size: z.number().int() });
export const DeviceLeaseSchema = z.object({ id: z.string(), sessionId: z.string(), at: z.string(), reason: z.string() });
export const RiffetDeviceActionSchema = z.object({
  id: z.string(), sessionId: z.string(), deviceId: z.string(), createdAt: z.string(),
  kind: z.enum(['act', 'launch', 'authorize']).meta({ open: true }), package: z.string().optional(),
  steps: z.array(z.object({ action: z.string(), target: z.string().optional(), effect: z.string().optional(), code: z.string().optional() })),
  category: z.string().optional(), authorizedBy: z.string().optional(), ok: z.boolean(), code: z.string().optional(),
});
export const DeviceAdbStatusSchema = z.object({ state: z.enum(['ready', 'unauthorized', 'absent', 'no-adb']).meta({ open: true }) });
export const DeviceAdbGrantSchema = z.object({ restrictedSettings: z.enum(['allowed', 'unsupported']).meta({ open: true }) });
