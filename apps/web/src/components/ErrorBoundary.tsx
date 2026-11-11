import * as React from 'react';
import { Trans } from '@lingui/react/macro';
import { IconRefreshCw, IconRotateCcw, IconTriangleAlert } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/controls';

interface Props {
  children: React.ReactNode;
  /**
   * Clearing this prop's value clears a caught error. A boundary that stays mounted while the
   * reader moves elsewhere would otherwise keep showing the failure of what they left.
   */
  resetKey?: string;
  /** `page` owns the whole document (nothing else can be shown); `surface` replaces one region. */
  variant?: 'page' | 'surface';
  /**
   * Places the fallback where the failed region would have appeared, for a region that is not part
   * of the layout flow (a dialog renders through a portal, so its fallback must too).
   */
  frame?: (fallback: React.ReactNode) => React.ReactNode;
}

interface State { error: Error | undefined }

/**
 * React unmounts the whole tree under a throw it cannot recover from, so a single bad row would
 * otherwise leave a blank page with no way back. There is no reporting endpoint — this is a local
 * tool — so the console keeps the record and the reader gets a retry that does not lose the app.
 */
export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: undefined };

  static getDerivedStateFromError(error: unknown): State {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: unknown, info: React.ErrorInfo): void {
    console.error('[riffet] render failed', error, info.componentStack);
  }

  componentDidUpdate(previous: Props): void {
    if (this.state.error && previous.resetKey !== this.props.resetKey) this.setState({ error: undefined });
  }

  private retry = (): void => { this.setState({ error: undefined }); };

  render(): React.ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    const page = this.props.variant === 'page';
    const fallback = (
      <div className={page ? 'flex h-dvh items-center justify-center bg-bg text-fg' : 'flex h-full min-h-0 min-w-0 flex-1 items-center justify-center bg-bg text-fg'}>
        <EmptyState icon={<IconTriangleAlert />} title={<Trans>界面渲染出错</Trans>} description={error.message || <Trans>这块内容没能画出来。</Trans>}>
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={this.retry}><IconRotateCcw /><Trans>重试</Trans></Button>
            <Button variant="ghost" size="sm" onClick={() => window.location.reload()}><IconRefreshCw /><Trans>重新加载</Trans></Button>
          </div>
        </EmptyState>
      </div>
    );
    return this.props.frame ? this.props.frame(fallback) : fallback;
  }
}
