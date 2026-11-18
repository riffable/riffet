import { useLingui } from '@lingui/react/macro';
import { IconCheck, IconCircleAlert, IconX } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/controls';
import { Tip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { DICTATION_LEVELS, DICTATION_WARN_MS, type DictationFailure, type DictationView } from './useDictation';

/** Bars a phone shows of `DICTATION_LEVELS`. */
const PHONE_LEVELS = 16;

export function clock(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** What a failure says to the person dictating. */
export function useFailureText(failure: DictationFailure | undefined): string | undefined {
  const { t } = useLingui();
  if (!failure) return undefined;
  if (failure.kind === 'capture') {
    switch (failure.problem) {
      case 'insecure': return t`麦克风只能在 HTTPS 地址下使用`;
      case 'unsupported': return t`这个浏览器无法录音`;
      case 'denied': return t`麦克风权限被拒绝，需要在浏览器设置里允许`;
      case 'no-microphone': return t`没有找到麦克风`;
      default: return t`无法打开麦克风`;
    }
  }
  const { code, message } = failure.problem;
  switch (code) {
    case 'DICTATION_OFF': return t`语音输入已关闭`;
    case 'RECOGNIZER_UNAVAILABLE': return t`语音识别插件未开启`;
    case 'DICTATION_DISCONNECTED': return t`与服务器的连接中断`;
    case 'DICTATION_BUSY': return t`同时进行的语音输入过多`;
    case 'TRANSCRIPTION_FAILED': return t`识别失败：${message}`;
    default: return message;
  }
}

/** A level bar's height in px, the same scale everywhere: a quiet room stays a dotted line, ordinary speech fills 20. */
export const levelHeight = (level: number) => Math.max(2, Math.min(20, 2 + level * 80));

/**
 * The composer's footer while dictating (docs/VOICE.md §7): cancel on the left, the recent loudness and the sentence still being
 * recognized in the middle, the time and done on the right, where send sits. A failure keeps the bar with its reason and,
 * when the recording can be sent again, retry.
 */
export function DictationBar({ view, onFinish, onCancel, onRetry }: { view: DictationView; onFinish: () => void; onCancel: () => void; onRetry: () => void }) {
  const { t } = useLingui();
  const failure = useFailureText(view.failure);
  const levels = Array.from({ length: DICTATION_LEVELS }, (_, index) => view.levels[index - (DICTATION_LEVELS - view.levels.length)] ?? 0);
  return (
    <div className="flex items-center gap-2 px-2 pb-2 pt-1" role="group" aria-label={t`语音输入`}>
      <Tip label={view.phase === 'failed' ? t`放弃` : t`取消`} kbd="Esc">
        <button type="button" aria-label={view.phase === 'failed' ? t`放弃` : t`取消`} onClick={onCancel}
          className="grid size-11 shrink-0 place-items-center rounded-md text-fg-3 outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-focus md:size-7">
          <IconX className="size-[18px]" />
        </button>
      </Tip>
      {view.phase === 'failed' ? <>
        <p role="alert" className="flex min-w-0 flex-1 items-center gap-1.5 text-xs text-danger">
          <IconCircleAlert className="size-3.5 shrink-0" />
          <span className="min-w-0 truncate" title={failure}>{failure}</span>
        </p>
        {view.failure?.kind === 'server' && view.failure.problem.retryable && <Button size="sm" variant="secondary" onClick={onRetry}>{t`重试`}</Button>}
      </> : <>
        <div className="flex h-5 shrink-0 items-center gap-0.5" aria-hidden>
          {levels.map((level, index) => (
            // A phone keeps the newest bars and gives the rest of the row to the text.
            <span key={index} className={cn('w-0.5 rounded-full bg-fg-3', index < DICTATION_LEVELS - PHONE_LEVELS && 'max-md:hidden')} style={{ height: `${levelHeight(level)}px` }} />
          ))}
        </div>
        {/* Right-to-left only to clip: a sentence too long for the row loses its start, and the newest words stay in view. */}
        <span className="min-w-0 flex-1 overflow-hidden whitespace-nowrap text-left text-sm text-fg-3 [direction:rtl]" aria-live="polite"><span dir="ltr" className="[unicode-bidi:isolate]">{view.live}</span></span>
        <span className={cn('shrink-0 text-xs tabular-nums', view.elapsedMs >= DICTATION_WARN_MS ? 'text-warning' : 'text-fg-3')}>{clock(view.elapsedMs)}</span>
        <Tip label={t`完成`} kbd="Enter">
          <button type="button" aria-label={t`完成`} aria-busy={view.phase === 'finishing' || undefined} disabled={view.phase === 'finishing'} onClick={onFinish}
            className={cn('relative grid size-9 shrink-0 place-items-center rounded-full bg-primary text-primary-fg transition-[background-color,transform] duration-[var(--duration-base)] ease-[var(--ease-standard)] before:absolute before:-inset-1 hover:bg-primary-hover active:scale-90 disabled:active:scale-100 md:size-8 md:before:hidden')}>
            {view.phase === 'finishing' ? <Spinner className="size-4 text-primary-fg" /> : <IconCheck className="size-4" />}
          </button>
        </Tip>
      </>}
    </div>
  );
}
