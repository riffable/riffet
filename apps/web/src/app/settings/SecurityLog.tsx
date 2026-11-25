import { useEffect, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import type { SecurityEvent } from '@contracts';
import { IconChevronRight } from '@/components/icons';
import { Collapse } from '@/components/ui/collapse';
import { Spinner } from '@/components/ui/controls';
import { api } from '@/lib/api';
import { cn, timeAgo } from '@/lib/utils';

const REFUSED = new Set<SecurityEvent['kind']>(['pairing-failed', 'login-failed', 'link-mismatch', 'access-denied']);

/** The security record (docs/TRANSPORT-SECURITY.md §7): who was let in, what changed who may do what, what was refused. */
export function SecurityLog() {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const [events, setEvents] = useState<SecurityEvent[]>();
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    api.securityEvents(controller.signal).then(({ events: list }) => setEvents(list)).catch(() => { if (!controller.signal.aborted) setEvents([]); });
    return () => controller.abort();
  }, [open]);

  const describe = (event: SecurityEvent): string => {
    const subject = event.subject ?? '';
    switch (event.kind) {
      case 'device-paired': return t`配对了 ${subject}`;
      case 'device-revoked': return t`移除了 ${subject}`;
      case 'pairing-failed': return t`配对码错误`;
      case 'login-failed': return t`访问令牌错误`;
      case 'sessions-revoked': return t`退出了所有浏览器`;
      case 'link-added': return t`与 ${subject} 互联`;
      case 'link-removed': return t`与 ${subject} 断开互联`;
      case 'link-inbound-changed': return event.detail === 'inbound' ? t`允许 ${subject} 操作这台电脑` : t`不再允许 ${subject} 操作这台电脑`;
      case 'link-mismatch': return t`${subject} 的证书与配对时不同`;
      case 'setting-changed': return subject === 'allowInsecureChat'
        ? event.detail === 'true' ? t`允许未加密连接对话` : t`禁止未加密连接对话`
        : event.detail === 'true' ? t`允许预览项目外的文件` : t`禁止预览项目外的文件`;
      case 'access-denied': return t`拒绝了 ${subject}`;
      case 'terminal-opened': return t`打开了终端`;
      case 'remote-exec': return event.detail === 'shell' ? t`打开了远程终端` : t`远程执行 ${event.detail ?? ''}`;
    }
  };
  const actor = (event: SecurityEvent) => [event.actor.name, event.actor.address].filter(Boolean).join(' · ');

  return <section className="flex flex-col">
    <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}
      className="-mx-1 flex h-7 items-center gap-1 self-start rounded-md px-1 text-xs font-medium text-fg-3 outline-none hover:text-fg-2 focus-visible:ring-2 focus-visible:ring-focus">
      <IconChevronRight className={cn('size-3.5 transition-transform', open && 'rotate-90')} />
      <Trans>安全记录</Trans>
    </button>
    <Collapse open={open}>
      {events === undefined ? <div className="flex justify-center py-3"><Spinner /></div>
        : events.length === 0 ? <p className="py-2 text-xs text-fg-3"><Trans>没有记录</Trans></p>
          : <ul className="flex flex-col gap-1 py-2">{events.map((event) => <li key={event.id} className="flex items-baseline gap-2 text-xs">
            <span className={cn('min-w-0 flex-1 truncate', REFUSED.has(event.kind) ? 'text-danger' : 'text-fg-2')} title={describe(event)}>{describe(event)}</span>
            <span className="max-w-48 shrink-0 truncate text-fg-3">{actor(event)}</span>
            <span className="shrink-0 text-fg-4">{timeAgo(event.at)}</span>
          </li>)}</ul>}
    </Collapse>
  </section>;
}
