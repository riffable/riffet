import { msg } from '@lingui/core/macro';
import { i18n } from '@lingui/core';

/**
 * Why the composer's model and permission controls cannot change anything right now.
 *
 * A switch asked for mid-turn is *not* one of these reasons: the backends that cannot apply one
 * without killing the turn record it and apply it at the next idle moment, so the control stays live
 * and the change lands with the next turn. What is left is the genuinely impossible — an archived
 * conversation, a switch already being written, and a model catalog that is not there yet.
 *
 * The sheet's own trigger must stay pressable: a `disabled` button dispatches no pointer events, so
 * the tap neither opened the sheet nor let `holdComposerFocus` hold the field — on a phone that is
 * indistinguishable from a broken control that also stole the keyboard.
 */

/** The states that make a change impossible. */
export interface PickerAvailability {
  archived: boolean;
  /** The model catalog is still loading, failed, or came back empty. */
  catalogUnavailable: boolean;
  /** A previous switch is still being written. */
  switching: boolean;
}

/** The one line to show for the state the user is in, or `undefined` when a change is possible. */
export function pickerBlockReason(availability: PickerAvailability): string | undefined {
  if (availability.archived) return i18n._(msg`会话已归档，先恢复再修改`);
  if (availability.switching) return i18n._(msg`正在切换上一项设置…`);
  if (availability.catalogUnavailable) return i18n._(msg`模型列表还没准备好，稍后再试`);
  return undefined;
}
