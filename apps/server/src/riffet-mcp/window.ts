import type { PublicDevice } from '../auth.js';
import { AppError } from '../errors.js';
import type { DeviceTool } from './service.js';

/*
 * T0 window capture on a Mac (docs/DEVICES.md §3「窗口截图」): two tools under one capability,
 * told apart by `args.list` the same way `device_list_apps` is told from `device_launch_app`.
 */

/** Whether a device gets the window tools: by platform, which does not change, so the tool list stays stable. */
export const isWindowDevice = (device: PublicDevice) => device.platform === 'mac' || (device.capabilities ?? []).includes('window.capture');

const WINDOW_ID_MAX = 0xffff_ffff;

export const WINDOW_TOOLS: readonly DeviceTool[] = [
  {
    name: 'device_list_windows', capability: 'window.capture',
    description: 'List the windows open on the Mac (id, app, title, size in points, onScreen), to choose one for device_capture_window.',
    properties: {}, args: () => ({ list: true }),
    render: result => {
      const windows = Array.isArray(result.windows) ? result.windows as Array<Record<string, unknown>> : [];
      if (!windows.length) return 'No windows.';
      return windows.map(item => `${String(item.id)}\t${String(item.app ?? '')}\t${String(item.title ?? '') || '(untitled)'}\t${String(item.width)}x${String(item.height)}${item.onScreen === false ? '\toff-screen' : ''}`).join('\n');
    },
  },
  {
    name: 'device_capture_window', capability: 'window.capture',
    description: 'Capture one window of the Mac as an image, by an id from device_list_windows. The window is not activated or raised, so the user is not disturbed. Returns the saved file path and a preview image.',
    properties: { windowId: { type: 'integer', minimum: 1, description: 'A window id from device_list_windows.' } }, required: ['windowId'],
    args: input => {
      const id = input.windowId;
      if (typeof id !== 'number' || !Number.isInteger(id) || id < 1 || id > WINDOW_ID_MAX) throw new AppError('INVALID_ARGUMENT', `windowId must be an integer from 1 to ${WINDOW_ID_MAX}`);
      return { windowId: id };
    },
  },
];
