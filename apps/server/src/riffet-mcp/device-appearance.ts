import { z } from 'zod/v4';
import { WORKBENCH_APPEARANCE_BUDGET } from '../../../../packages/contracts/src/budgets.js';
import { DeviceAppearanceRequestSchema, DeviceAppearanceResultSchema } from '../../../../packages/contracts/src/schema/devices.js';
import { AppError } from '../errors.js';
import type { Session } from '../../../../packages/contracts/src/session.js';
import type { Auth } from '../auth.js';
import { deviceGroupIds, type DeviceChannel } from './devices.js';

const id = z.string().trim().min(1).max(140);
const input = DeviceAppearanceRequestSchema.extend({ device: id, sourceTurn: z.string().min(1).max(64) });
export const deviceAppearanceTool = {
  name: 'device_riffet_appearance',
  description: 'Read or change Riffet’s own appearance on one explicitly identified, authorized paired client. Call list_devices for its ID. With device and this message’s sourceTurn only, read its supported themes, modes and styles. Send only values that client supports. Ask which Riffet client the owner means when unclear.',
  inputSchema: z.toJSONSchema(input, {target:'draft-7'}),
};
export async function deviceAppearance(
  session: Session, args: unknown, authorize: (proof: string)=>void,
  channel: DeviceChannel, auth: Auth, signal?: AbortSignal,
) {
  const parsed = input.safeParse(args);
  if (!parsed.success) throw new AppError('INVALID_ARGUMENT','Specify the paired Riffet client ID and valid appearance options.');
  const {device:deviceId, sourceTurn, ...change} = parsed.data;
  authorize(sourceTurn);
  if (!deviceGroupIds(session).includes(deviceId)) throw new AppError('DEVICE_NOT_ALLOWED','That Riffet client was not granted to this conversation.',403);
  const device = auth.device(deviceId);
  if (!device?.allowControl) throw new AppError('DEVICE_NOT_ALLOWED','The paired client has not enabled control.',403);
  if (!device.capabilities?.includes('riffet.appearance')) throw new AppError('DEVICE_CAPABILITY_MISSING','The paired client has not offered Riffet appearance controls.',409);
  if (!channel.online(deviceId) || signal?.aborted) throw new AppError('DEVICE_UNREACHABLE','Open Riffet on the selected device before sending a setting.',409);
  const call = await channel.call({ sessionId:session.id, deviceId, capability:'riffet.appearance', args:change, timeoutMs:WORKBENCH_APPEARANCE_BUDGET.callMs, signal });
  const outcome = call.receipt?.outcome;
  if (!outcome) throw new AppError(call.error?.code ?? 'DEVICE_UNREACHABLE','The selected Riffet client did not confirm the result.',409);
  if (!outcome.ok) throw new AppError(outcome.code,outcome.message ?? 'The selected Riffet client rejected the change.',409);
  const result = DeviceAppearanceResultSchema.safeParse(outcome.result);
  if (!result.success || (change.mode && change.mode !== result.data.mode)
    || (change.themeId && (result.data.activePaletteId ?? result.data.themeId) !== change.themeId)
    || (change.interfaceStyle && result.data.interfaceStyle !== change.interfaceStyle)) {
    throw new AppError('WORKBENCH_RESULT_UNKNOWN','The selected Riffet client did not confirm the requested value.',409);
  }
  return { device:deviceId, scope:'device', ...result.data };
}
