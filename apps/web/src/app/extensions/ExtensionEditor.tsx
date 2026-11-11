import { useMemo } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { unifiedMergeView } from '@codemirror/merge';
import { EditorView } from '@codemirror/view';
import { useLingui } from '@lingui/react/macro';
import { useTheme } from '@/lib/theme';

interface Props {
  value: string;
  original: string;
  preview: boolean;
  readOnly: boolean;
  onChange(value: string): void;
}

/** Loaded only when a source file is opened. The overview never loads CodeMirror. */
export default function ExtensionEditor({ value, original, preview, readOnly, onChange }: Props) {
  const { t } = useLingui();
  const { resolved } = useTheme();
  const extensions = useMemo(() => [
    EditorView.theme({
      '&': { height: '100%', minHeight: '0' },
      '.cm-scroller': { overflow: 'auto', maxHeight: '100%', overscrollBehavior: 'contain' },
    }),
    ...(preview ? [unifiedMergeView({
      original, highlightChanges: true, gutter: true, mergeControls: false,
    })] : []),
  ], [preview, original]);

  return <div className="extensions-editor cm-host min-w-0 overflow-hidden rounded-lg border border-line">
    <CodeMirror
      className="h-full min-h-0"
      aria-label={preview ? t`扩展文件保存预览` : t`扩展文件内容`}
      value={value}
      height="100%"
      maxHeight="100%"
      theme={resolved}
      extensions={extensions}
      readOnly={readOnly || preview}
      editable={!readOnly && !preview}
      onChange={onChange}
      basicSetup={{ foldGutter: false, autocompletion: false, highlightActiveLine: false }}
    />
  </div>;
}
