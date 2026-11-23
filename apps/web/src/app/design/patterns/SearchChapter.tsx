import { useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import { IconListFilter, IconSearch } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { EmptyState, Kbd, Segmented } from '@/components/ui/controls';
import { SearchField } from '@/components/ui/search-field';
import type { RecentSearch } from '@/lib/recent-searches';
import { RecentSearchChip } from '../../SessionSearchDialog';
import { Chapter, Frame, Matrix, Plate } from '../specimen';

/** The shared SearchField: Escape clears, then blurs. */
function Field() {
  const { t } = useLingui();
  const [query, setQuery] = useState('');
  return (
    <Frame className="flex justify-center p-8 max-md:p-4">
      <SearchField className="w-full max-w-sm" aria-label={t`搜索扩展`} placeholder={t`搜索扩展`} value={query} onChange={setQuery} hint={<Kbd>/</Kbd>} />
    </Frame>
  );
}

function RecentSearches() {
  const { t } = useLingui();
  const [entries, setEntries] = useState<RecentSearch[]>([{ query: 'README', mode: 'title' }, { query: 'fetch', mode: 'content' }]);
  const [query, setQuery] = useState('');
  return (
    <Frame className="p-8 max-md:p-4">
      <div className="mx-auto w-full max-w-sm space-y-1">
        <SearchField aria-label={t`搜索会话`} value={query} onChange={setQuery} />
        {!query && <div role="listbox" aria-label={t`最近搜索`} className="flex flex-wrap gap-1.5">
          {entries.map((entry, index) => <RecentSearchChip key={entry.query} entry={entry} selected={index === 0}
            onSelect={() => setQuery(entry.query)} onRemove={() => setEntries(entries.filter(item => item !== entry))} />)}
        </div>}
      </div>
    </Frame>
  );
}

function Filters() {
  const { t } = useLingui();
  const [kind, setKind] = useState('all');
  return (
    <Frame className="flex items-center justify-center gap-3 p-8 max-md:p-4">
      <Segmented size="xs" value={kind} onChange={setKind} ariaLabel={t`类型`} options={[{ value: 'all', label: t`全部` }, { value: 'plugin', label: t`插件` }, { value: 'skill', label: t`技能` }]} />
      <Button size="icon-sm" variant="quiet" aria-label={t`筛选`}><IconListFilter /></Button>
    </Frame>
  );
}

function NoResults() {
  const { t } = useLingui();
  return (
    <Frame className="p-8 max-md:p-4">
      <div className="mx-auto max-w-md rounded-xl bg-bg shadow-[0_0_0_1px_var(--line)]">
        <EmptyState icon={<IconSearch />} title={t`没有符合条件的收藏`} />
      </div>
    </Frame>
  );
}

function Migrated() {
  const { t } = useLingui();
  return (
    <Frame className="p-8 max-md:p-4">
      <Matrix
        columns={[t`位置`, t`写法`]}
        rows={[
          { label: 'ExtensionsPage · PluginsPage · MarksPage', cells: ['SearchField'] },
          { label: 'CommandPalette · SessionSearchDialog · ImportSessionDialog', cells: [t`QuickInput：组合框，Escape 关闭浮层`] },
          { label: 'Sidebar', cells: [t`按钮，打开搜索浮层`] },
        ]}
      />
    </Frame>
  );
}

export function SearchChapter() {
  const { t } = useLingui();
  return (
    <Chapter title={t`搜索与筛选`} lede={t`搜索框在左侧放搜索图标，有内容时右侧放清除，Escape 先清空再离开。列表页共用 SearchField。`} tone="canvas" source="docs/design/system/patterns.md">
      <Plate number={1} title={t`搜索框`} note={t`空时右侧提示聚焦键，有内容时换成清除。`}>
        <Field />
      </Plate>
      <Plate number={2} title={t`筛选`} note={t`筛选的选项固定且少，用分段控件；更多条件收进图标按钮的弹出层。`}>
        <Filters />
      </Plate>
      <Plate number={3} title={t`无结果`} note={t`标题写明没有符合什么；关键词不在结果里高亮。`}>
        <NoResults />
      </Plate>
      <Plate number={4} title={t`最近搜索`}>
        <RecentSearches />
      </Plate>
      <Plate number={5} title={t`使用处`} note={t`列表页共用 SearchField；浮层里的查询行是组合框，另有写法。`}>
        <Migrated />
      </Plate>
    </Chapter>
  );
}
