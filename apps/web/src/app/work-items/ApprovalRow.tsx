import { useLayoutEffect, useRef, useState } from 'react';
import { i18n } from '@lingui/core';
import { useLingui } from '@lingui/react/macro';
import type { PluginApproval, PluginApprovalAction } from '@contracts';
import { Button } from '@/components/ui/button';
import { IconShieldCheck } from '@/components/icons';
import { relativeTime } from '@/lib/i18n/format';
import { localizedText } from '@/lib/plugins';
import { toast } from '@/lib/toast';
import { cn, errorMessage } from '@/lib/utils';
import { Markdown } from '../session/Markdown';
import { useStores } from '../state/stores';

const BUTTON_VARIANT = { primary: 'primary', danger: 'danger', neutral: 'secondary' } as const;
const COLLAPSED_BODY = 'max-h-[4.5rem] overflow-hidden';

/**
 * A plugin's pending write, waiting in the inbox's 要你回答 for a button (docs/TASK-BOARD.md §7). The plugin does the
 * write when one is pressed; a refusal is shown and the row stays, so the owner can press again.
 */
export function ApprovalRow({ approval }: { approval: PluginApproval }) {
  const { t } = useLingui();
  const { approvals } = useStores();
  const [busy, setBusy] = useState<string>();
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = bodyRef.current;
    if (element && !expanded) setOverflows(element.scrollHeight > element.clientHeight + 1);
  }, [approval.body, expanded]);

  const decide = async (action: PluginApprovalAction) => {
    if (busy) return;
    setBusy(action.id);
    try {
      const result = await approvals.decide(approval, action.id);
      const message = localizedText(result.message, [i18n.locale]);
      if (message) toast.success(message);
    } catch (error) {
      toast.error(errorMessage(error, t`无法完成这项操作`));
      void approvals.reload();
    } finally { setBusy(undefined); }
  };

  return (
    <div data-plugin-approval="" className="flex flex-col gap-1.5 rounded-lg px-2.5 py-2 text-sm text-fg">
      <div className="flex min-h-5 min-w-0 items-center gap-2">
        <span className="grid size-4 shrink-0 place-items-center text-warning"><IconShieldCheck /></span>
        <span className="min-w-0 flex-1 truncate font-medium">{approval.title}</span>
        <span className="hidden max-w-40 shrink-0 truncate text-xs text-fg-4 sm:inline">{approval.pluginName}</span>
        <span className="shrink-0 whitespace-nowrap text-2xs tabular-nums text-fg-4">{relativeTime(approval.createdAt)}</span>
      </div>
      <div className="flex min-w-0 flex-col gap-1.5 pl-6">
        {approval.body && (
          <>
            <div ref={bodyRef} className={cn('min-w-0 text-fg-2', !expanded && COLLAPSED_BODY)}>
              <Markdown className="text-sm select-text" text={approval.body} />
            </div>
            {(overflows || expanded) && (
              <Button size="xs" variant="quiet" className="-ml-2 self-start" aria-expanded={expanded} onClick={() => setExpanded((open) => !open)}>
                {expanded ? t`收起` : t`展开`}
              </Button>
            )}
          </>
        )}
        <div className="flex flex-wrap items-center gap-2">
          {approval.actions.map((action) => (
            <Button key={action.id} size="sm" variant={BUTTON_VARIANT[action.tone ?? 'neutral']} busy={busy === action.id} disabled={busy !== undefined && busy !== action.id} onClick={() => void decide(action)}>
              {action.label}
            </Button>
          ))}
        </div>
      </div>
    </div>
  );
}
