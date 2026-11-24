import {
  ICONS,
  MAX_EXPAND_ALL_NODES,
  SOURCE_PAGE,
  TABLE_PAGE,
  appendHighlighted,
  copyText,
  discoverColumns,
  el,
  formatCopyValue,
  formatSourceText,
  isPlainObject,
  isTabularCandidate,
  ownGet,
  recordBadge,
  renderCellContent,
  renderJsonHighlightedLine,
  svgIcon,
  valueMatchesQuery,
  type StructuredPayload,
  type ViewMode,
} from './browser-structured-shared.js';
import { injectStyles } from './browser-structured-styles.js';
import { createTreeRenderer } from './browser-structured-tree.js';

function main() {
  const input = document.getElementById('riffet-preview-data');
  if (!input?.textContent) throw new Error('缺少结构化预览数据');
  const payload = JSON.parse(input.textContent) as StructuredPayload;
  input.remove();

  injectStyles(payload.theme);
  const host = document.getElementById('preview') ?? document.body;
  const root = el('div');
  root.id = 'st-root';
  host.replaceWith(root);

  const tabular = isTabularCandidate(payload);
  const isJsonLines = payload.format === 'jsonl' || payload.format === 'ndjson';
  let mode: ViewMode = tabular && isJsonLines ? 'table' : 'tree';
  let query = '';
  let expandState: boolean | null = null;
  let selectedRowIndex: number | undefined = tabular && Array.isArray(payload.value) && payload.value.length > 0 ? 0 : undefined;
  let activeObserver: IntersectionObserver | undefined;
  let activeCleanup: (() => void) | undefined;
  let stepCurrentRow: ((delta: -1 | 1) => void) | undefined;
  let closeCurrentInspector: (() => void) | undefined;
  let searchTimer: number | undefined;

  // Toolbar
  const toolbar = el('div', 'st-toolbar');
  const searchWrap = el('div', 'st-search-wrap');
  const searchIcon = svgIcon(ICONS.search);
  searchIcon.classList.add('st-search-icon');
  const searchInput = el('input', 'st-search');
  searchInput.type = 'search';
  searchInput.placeholder = '筛选… (⌘F)';
  searchInput.setAttribute('aria-label', '筛选字段或值');
  const searchMeta = el('span', 'st-search-meta');
  const searchClear = el('button', 'st-search-clear');
  searchClear.type = 'button';
  searchClear.hidden = true;
  searchClear.setAttribute('aria-label', '清除筛选');
  searchClear.append(svgIcon(ICONS.close));
  searchWrap.append(searchIcon, searchInput, searchMeta, searchClear);

  const seg = el('div', 'st-seg');
  seg.setAttribute('role', 'tablist');
  const modeButtons = new Map<ViewMode, HTMLButtonElement>();
  const modes: [ViewMode, string][] = tabular ? [['table', '表格'], ['tree', '树'], ['source', '源码']] : [['tree', '树'], ['source', '源码']];
  for (const [m, label] of modes) {
    const btn = el('button', undefined, label);
    btn.type = 'button';
    btn.setAttribute('role', 'tab');
    btn.addEventListener('click', () => {
      if (mode === m) return;
      mode = m;
      renderView();
    });
    modeButtons.set(m, btn);
    seg.append(btn);
  }

  const actions = el('div', 'st-actions');
  const expandBtn = el('button', 'st-btn');
  expandBtn.type = 'button';
  expandBtn.title = '全部展开';
  expandBtn.setAttribute('aria-label', '全部展开');
  expandBtn.append(svgIcon(ICONS.expandAll));
  expandBtn.addEventListener('click', () => { expandState = true; renderView(); });

  const collapseBtn = el('button', 'st-btn');
  collapseBtn.type = 'button';
  collapseBtn.title = '全部折叠';
  collapseBtn.setAttribute('aria-label', '全部折叠');
  collapseBtn.append(svgIcon(ICONS.collapseAll));
  collapseBtn.addEventListener('click', () => { expandState = false; renderView(); });

  const copyAllBtn = el('button', 'st-btn');
  copyAllBtn.type = 'button';
  copyAllBtn.title = '复制全部内容';
  copyAllBtn.setAttribute('aria-label', '复制全部内容');
  const copyAllIcon = svgIcon(ICONS.copy);
  copyAllBtn.append(copyAllIcon);
  copyAllBtn.addEventListener('click', () => {
    void copyText(formatSourceText(payload)).then(ok => {
      if (!ok) return;
      copyAllBtn.classList.add('is-ok');
      copyAllBtn.replaceChildren(svgIcon(ICONS.check));
      setTimeout(() => {
        copyAllBtn.classList.remove('is-ok');
        copyAllBtn.replaceChildren(svgIcon(ICONS.copy));
      }, 1200);
    });
  });

  actions.append(expandBtn, collapseBtn, copyAllBtn);
  toolbar.append(searchWrap, seg, actions);

  const notice = el('div', 'st-notice');
  const noticeText = el('span');
  const noticeStats = el('span');
  notice.append(noticeText, noticeStats);
  const clippedLabel = payload.totalLines ? `共 ${payload.totalLines} 条，仅展示前一部分` : '内容较多，仅展示前一部分';
  const syncNotice = (extra?: string) => {
    if (extra) {
      notice.hidden = false;
      noticeText.textContent = extra;
    } else if (payload.clipped) {
      notice.hidden = false;
      noticeText.textContent = clippedLabel;
    } else {
      notice.hidden = true;
    }
  };
  syncNotice();

  const stage = el('div', 'st-stage');
  root.append(toolbar, notice, stage);

  const treeRenderer = createTreeRenderer({
    rootData: payload,
    defaultOpenDepth: 2,
    maxAutoOpenKeys: 12,
  });

  function syncToolbar() {
    for (const [m, btn] of modeButtons) btn.setAttribute('aria-selected', String(m === mode));
    expandBtn.hidden = mode !== 'tree';
    collapseBtn.hidden = mode !== 'tree';
    searchClear.hidden = !query;
  }

  function renderTableView() {
    const rows = (payload.value as unknown[]) ?? [];
    const { columns, hasScalarFallback } = discoverColumns(rows);
    const lowerQuery = query.trim().toLowerCase();
    const filteredIndices: number[] = [];
    for (let i = 0; i < rows.length; i++) {
      if (!lowerQuery || valueMatchesQuery(rows[i], lowerQuery)) filteredIndices.push(i);
    }
    if (selectedRowIndex !== undefined && !filteredIndices.includes(selectedRowIndex)) {
      selectedRowIndex = filteredIndices[0];
    }

    searchMeta.textContent = lowerQuery ? `${filteredIndices.length}/${rows.length}` : `${rows.length} 条`;

    const tablePane = el('div', 'st-table-pane');
    const resizer = el('div', 'st-resizer');
    const inspector = el('div', 'st-inspector');
    resizer.hidden = true;
    inspector.hidden = true;

    const inspectorHead = el('div', 'st-inspector-head');
    const inspectorTitle = el('div', 'st-inspector-title');
    const inspectorLabel = el('span');
    const inspectorBadge = el('span', 'st-inspector-badge');
    inspectorTitle.append(inspectorLabel, inspectorBadge);

    const prevBtn = el('button', 'st-btn');
    prevBtn.type = 'button'; prevBtn.title = '上一条 (↑)'; prevBtn.setAttribute('aria-label', '上一条');
    prevBtn.append(svgIcon(ICONS.up));
    const nextBtn = el('button', 'st-btn');
    nextBtn.type = 'button'; nextBtn.title = '下一条 (↓)'; nextBtn.setAttribute('aria-label', '下一条');
    nextBtn.append(svgIcon(ICONS.down));
    const copyRowBtn = el('button', 'st-btn', '复制');
    copyRowBtn.type = 'button'; copyRowBtn.title = '复制该条 JSON';
    const closeInspectorBtn = el('button', 'st-btn');
    closeInspectorBtn.type = 'button'; closeInspectorBtn.title = '关闭 (Esc)'; closeInspectorBtn.setAttribute('aria-label', '关闭详情');
    closeInspectorBtn.append(svgIcon(ICONS.close));
    inspectorHead.append(inspectorTitle, prevBtn, nextBtn, copyRowBtn, closeInspectorBtn);

    const inspectorBody = el('div', 'st-tree-scroll');
    inspector.append(inspectorHead, inspectorBody);

    const rowElements = new Map<number, HTMLTableRowElement>();

    const updateInspector = () => {
      for (const [idx, tr] of rowElements) tr.classList.toggle('is-selected', idx === selectedRowIndex);
      if (selectedRowIndex === undefined || selectedRowIndex < 0 || selectedRowIndex >= rows.length) {
        resizer.hidden = true;
        inspector.hidden = true;
        return;
      }
      const pos = filteredIndices.indexOf(selectedRowIndex);
      const record = rows[selectedRowIndex];
      resizer.hidden = false;
      inspector.hidden = false;
      inspectorLabel.textContent = `第 ${selectedRowIndex + 1} 条`;
      inspectorBadge.textContent = recordBadge(record) ?? '';
      prevBtn.disabled = pos <= 0;
      nextBtn.disabled = pos === -1 || pos >= filteredIndices.length - 1;

      const rowRenderer = createTreeRenderer({
        rootData: { ...payload, kind: 'value', value: record },
        defaultOpenDepth: 2,
        maxAutoOpenKeys: 16,
      });
      rowRenderer.render(inspectorBody, lowerQuery, null);
      inspectorBody.scrollTop = 0;

      const selectedTr = rowElements.get(selectedRowIndex);
      selectedTr?.scrollIntoView({ block: 'nearest' });
    };

    const stepInspector = (delta: -1 | 1) => {
      if (!filteredIndices.length) return;
      if (selectedRowIndex === undefined) {
        selectedRowIndex = filteredIndices[0];
      } else {
        const pos = filteredIndices.indexOf(selectedRowIndex);
        const nextPos = pos === -1 ? 0 : Math.max(0, Math.min(filteredIndices.length - 1, pos + delta));
        selectedRowIndex = filteredIndices[nextPos];
      }
      updateInspector();
    };

    prevBtn.addEventListener('click', () => stepInspector(-1));
    nextBtn.addEventListener('click', () => stepInspector(1));
    closeInspectorBtn.addEventListener('click', () => { selectedRowIndex = undefined; updateInspector(); });
    copyRowBtn.addEventListener('click', () => {
      if (selectedRowIndex === undefined) return;
      void copyText(formatCopyValue(rows[selectedRowIndex])).then(ok => {
        if (!ok) return;
        copyRowBtn.textContent = '已复制';
        copyRowBtn.classList.add('is-ok');
        setTimeout(() => { copyRowBtn.textContent = '复制'; copyRowBtn.classList.remove('is-ok'); }, 1200);
      });
    });

    // Drag resize between table and inspector
    resizer.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      try { resizer.setPointerCapture(event.pointerId); } catch { /* ignore */ }
      const startY = event.clientY;
      const startHeight = inspector.getBoundingClientRect().height;
      const stageHeight = stage.getBoundingClientRect().height;
      const onMove = (move: PointerEvent) => {
        const next = Math.max(120, Math.min(stageHeight * 0.78, startHeight - (move.clientY - startY)));
        inspector.style.height = `${next}px`;
      };
      const cleanupDrag = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', cleanupDrag);
        window.removeEventListener('pointercancel', cleanupDrag);
        try { if (resizer.hasPointerCapture(event.pointerId)) resizer.releasePointerCapture(event.pointerId); } catch { /* ignore */ }
        activeCleanup = undefined;
      };
      activeCleanup?.();
      activeCleanup = cleanupDrag;
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', cleanupDrag);
      window.addEventListener('pointercancel', cleanupDrag);
    });

    if (!filteredIndices.length) {
      tablePane.append(el('div', 'st-empty', '没有匹配的记录'));
      stage.append(tablePane);
      return;
    }

    const table = el('table', 'st-table');
    const thead = el('thead');
    const headRow = el('tr');
    headRow.append(el('th', 'st-col-num', '#'));
    for (const col of columns) headRow.append(el('th', undefined, col));
    if (hasScalarFallback) headRow.append(el('th', undefined, '(value)'));
    thead.append(headRow);
    const tbody = el('tbody');
    table.append(thead, tbody);

    const sentinel = el('div', 'st-sentinel');
    tablePane.append(table, sentinel);
    stage.append(tablePane, resizer, inspector);

    let renderedCursor = 0;
    const appendBatch = () => {
      if (renderedCursor >= filteredIndices.length) return;
      const frag = document.createDocumentFragment();
      const limit = Math.min(filteredIndices.length, renderedCursor + TABLE_PAGE);
      for (; renderedCursor < limit; renderedCursor++) {
        const rowIndex = filteredIndices[renderedCursor]!;
        const row = rows[rowIndex];
        const tr = el('tr');
        if (rowIndex === selectedRowIndex) tr.classList.add('is-selected');
        tr.append(el('td', 'st-col-num', String(rowIndex + 1)));

        if (isPlainObject(row)) {
          for (const col of columns) {
            const td = el('td');
            const got = ownGet(row, col);
            renderCellContent(td, got.value, got.present, lowerQuery);
            tr.append(td);
          }
          if (hasScalarFallback) {
            const td = el('td');
            td.append(el('span', 'st-cell-empty', '—'));
            tr.append(td);
          }
        } else {
          for (let c = 0; c < columns.length; c++) {
            const td = el('td');
            td.append(el('span', 'st-cell-empty', '—'));
            tr.append(td);
          }
          if (hasScalarFallback) {
            const td = el('td');
            renderCellContent(td, row, true, lowerQuery);
            tr.append(td);
          }
        }

        tr.addEventListener('click', () => {
          selectedRowIndex = selectedRowIndex === rowIndex ? undefined : rowIndex;
          updateInspector();
        });
        rowElements.set(rowIndex, tr);
        frag.append(tr);
      }
      tbody.append(frag);
    };

    appendBatch();
    if (selectedRowIndex !== undefined) {
      while (renderedCursor < filteredIndices.length && !rowElements.has(selectedRowIndex)) appendBatch();
      updateInspector();
    }

    if (renderedCursor < filteredIndices.length) {
      activeObserver = new IntersectionObserver(entries => {
        if (entries.some(entry => entry.isIntersecting)) {
          appendBatch();
          if (renderedCursor >= filteredIndices.length) activeObserver?.disconnect();
        }
      }, { root: tablePane, rootMargin: '300px' });
      activeObserver.observe(sentinel);
    }

    stepCurrentRow = stepInspector;
    closeCurrentInspector = () => {
      if (selectedRowIndex === undefined) return;
      selectedRowIndex = undefined;
      updateInspector();
    };
  }

  function renderTreeView() {
    const scroll = el('div', 'st-tree-scroll');
    const lowerQuery = query.trim().toLowerCase();
    const result = treeRenderer.render(scroll, lowerQuery, expandState);
    searchMeta.textContent = lowerQuery ? `${result.matches} 处` : '';
    syncNotice(expandState === true && result.expandedCount >= MAX_EXPAND_ALL_NODES ? `节点较多，仅展开前 ${MAX_EXPAND_ALL_NODES} 个节点` : undefined);
    stage.append(scroll);
  }

  function renderSourceView() {
    const scroll = el('div', 'st-source-scroll');
    const text = formatSourceText(payload);
    const lines = text.split(/\r?\n/);
    const lowerQuery = query.trim().toLowerCase();
    const isJsonStyle = payload.source === undefined;

    if (payload.sourceClipped) {
      syncNotice(payload.clipped ? `${clippedLabel}；源码仅展示前 512 KB` : '源码仅展示前 512 KB');
    }

    const visibleLines: { num: number; text: string }[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (!lowerQuery || line.toLowerCase().includes(lowerQuery)) {
        visibleLines.push({ num: i + 1, text: line });
      }
    }
    searchMeta.textContent = lowerQuery ? `${visibleLines.length} 行` : `${lines.length} 行`;

    const sentinel = el('div', 'st-sentinel');
    stage.append(scroll);
    scroll.append(sentinel);

    let cursor = 0;
    const appendBatch = () => {
      if (cursor >= visibleLines.length) return;
      const frag = document.createDocumentFragment();
      const limit = Math.min(visibleLines.length, cursor + SOURCE_PAGE);
      for (; cursor < limit; cursor++) {
        const entry = visibleLines[cursor]!;
        const row = el('div', 'st-src-line');
        row.append(el('span', 'st-src-num', String(entry.num)));
        const code = el('span', 'st-src-code');
        if (isJsonStyle) renderJsonHighlightedLine(code, entry.text, lowerQuery);
        else appendHighlighted(code, entry.text, lowerQuery);
        row.append(code);
        frag.append(row);
      }
      scroll.insertBefore(frag, sentinel);
    };

    appendBatch();
    if (lowerQuery && visibleLines.length === 0) {
      scroll.insertBefore(el('div', 'st-empty', '没有匹配的行'), sentinel);
    }
    if (cursor < visibleLines.length) {
      activeObserver = new IntersectionObserver(entries => {
        if (entries.some(entry => entry.isIntersecting)) {
          appendBatch();
          if (cursor >= visibleLines.length) activeObserver?.disconnect();
        }
      }, { root: scroll, rootMargin: '400px' });
      activeObserver.observe(sentinel);
    }
  }

  function renderView() {
    if (searchTimer !== undefined) {
      clearTimeout(searchTimer);
      searchTimer = undefined;
    }
    activeObserver?.disconnect();
    activeObserver = undefined;
    activeCleanup?.();
    activeCleanup = undefined;
    stepCurrentRow = undefined;
    closeCurrentInspector = undefined;
    stage.replaceChildren();
    syncToolbar();
    syncNotice();
    if (mode === 'table') renderTableView();
    else if (mode === 'tree') renderTreeView();
    else renderSourceView();
  }

  searchInput.addEventListener('input', () => {
    query = searchInput.value;
    syncToolbar();
    if (searchTimer !== undefined) clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
      searchTimer = undefined;
      renderView();
    }, 90);
  });

  searchClear.addEventListener('click', () => {
    query = '';
    searchInput.value = '';
    searchInput.focus();
    renderView();
  });

  window.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      searchInput.focus();
      searchInput.select();
    } else if (event.key === '/' && document.activeElement !== searchInput) {
      event.preventDefault();
      searchInput.focus();
    } else if (event.key === 'Escape') {
      if (document.activeElement === searchInput && query) {
        query = '';
        searchInput.value = '';
        renderView();
      } else if (mode === 'table' && selectedRowIndex !== undefined) {
        closeCurrentInspector?.();
      }
    } else if (mode === 'table' && document.activeElement !== searchInput && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault();
      stepCurrentRow?.(event.key === 'ArrowDown' ? 1 : -1);
    }
  });

  renderView();
}

try {
  main();
} catch (error) {
  const failure = document.createElement('p');
  failure.style.padding = '16px';
  failure.textContent = error instanceof Error ? `预览失败：${error.message}` : '预览失败';
  document.body.replaceChildren(failure);
}
