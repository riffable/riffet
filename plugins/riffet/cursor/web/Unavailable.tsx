import { Icon, useMessages, type UnavailableInfo } from '@riffet/plugin-web';
import { catalogs } from './messages';

/** Shown when a request answers that Cursor is off, such as the plugin being turned off while a page is open. */
export function Unavailable({ info }: { info: UnavailableInfo }) {
  const m = useMessages(catalogs);
  return (
    <p role="alert" className="flex items-start gap-2 rounded-lg bg-warning-soft px-3 py-2 text-xs text-warning">
      <Icon name="circle-alert" className="mt-px size-3.5 shrink-0" />{m.unavailable(info.reason)}
    </p>
  );
}
