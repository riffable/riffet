/**
 * Runs one auxiliary job — a session title or a handoff summary — on the selected model, without
 * saving a setting or creating a session. The result stays in the dialog, selectable, until the
 * input changes.
 */
import { useEffect, useRef, useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import type { AuxiliaryModelPurpose, AuxiliaryModelRef } from '@contracts';
import { Button } from '@/components/ui/button';
import { Field, Textarea } from '@/components/ui/controls';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/utils';

/** The purposes that answer one bounded job, which is what a preview tries. */
export type PreviewPurpose = Exclude<AuxiliaryModelPurpose, 'chat' | 'summary'>;
const LIMITS: Record<PreviewPurpose, number> = { title: 2_000, handoff: 150_000 };

export function AuxiliaryPreviewDialog({ open, purpose, model, onOpenChange }: {
  open: boolean;
  purpose: PreviewPurpose;
  model: AuxiliaryModelRef;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useLingui();
  const [input, setInput] = useState('');
  const [result, setResult] = useState('');
  const [error, setError] = useState('');
  const [generating, setGenerating] = useState(false);
  const [shownOpen, setShownOpen] = useState(open);
  const abortRef = useRef<AbortController>(undefined);

  // A fresh input and result per opening; the last one never leaks into the next trial.
  if (open !== shownOpen) {
    setShownOpen(open);
    if (open) {
      abortRef.current?.abort();
      abortRef.current = undefined;
      setInput('');
      setResult('');
      setError('');
      setGenerating(false);
    }
  }

  useEffect(() => () => abortRef.current?.abort(), []);

  const limit = LIMITS[purpose];
  const tooLong = input.length > limit;
  const canGenerate = Boolean(input.trim()) && !tooLong && !generating;

  const changeOpen = (next: boolean) => {
    if (!next) {
      abortRef.current?.abort();
      abortRef.current = undefined;
    }
    onOpenChange(next);
  };

  const changeInput = (value: string) => {
    // An answer to the previous input must not appear under the new one.
    abortRef.current?.abort();
    abortRef.current = undefined;
    setGenerating(false);
    setInput(value);
    setResult('');
    setError('');
  };

  const generate = async () => {
    if (!canGenerate || abortRef.current) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setGenerating(true);
    setResult('');
    setError('');
    try {
      const { text } = await api.previewAuxiliaryModel({ purpose, ...model, message: input.trim() }, controller.signal);
      if (!controller.signal.aborted) setResult(text);
    } catch (cause) {
      if (!controller.signal.aborted) setError(errorMessage(cause));
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = undefined;
        setGenerating(false);
      }
    }
  };

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{purpose === 'title' ? t`会话标题` : t`交接摘要`}</DialogTitle>
          <DialogDescription className="truncate font-mono text-xs">{model.model}</DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-3">
          <Field label={t`输入`}>
            <Textarea
              autoFocus
              value={input}
              placeholder={purpose === 'title' ? t`输入一条会话消息` : t`粘贴对话内容`}
              disabled={generating}
              onChange={(event) => changeInput(event.target.value)}
              className="min-h-30"
            />
          </Field>
          {result && (
            <Field label={t`结果`}>
              <Textarea readOnly rows={purpose === 'title' ? 3 : 10} value={result} className={`select-all resize-none ${purpose === 'title' ? 'max-h-20' : 'max-h-55'}`} />
            </Field>
          )}
          {tooLong
            ? <p role="alert" className="text-sm text-danger">{t`最多 ${limit} 个字符`}</p>
            : error && <p role="alert" className="text-sm text-danger">{error}</p>}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={() => changeOpen(false)}>{t`关闭`}</Button>
          <Button variant="primary" disabled={!canGenerate && !generating} busy={generating} onClick={() => void generate()}>
            {t`生成`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
