import {
  LONG_STRING_THRESHOLD,
  MAX_EXPAND_ALL_NODES,
  appendHighlighted,
  copyText,
  el,
  formatCopyValue,
  formatJsonPath,
  isPlainObject,
  ownEntries,
  singleLinePreview,
  svgIcon,
  valueMatchesQuery,
  xmlMatchesQuery,
  type StructuredPayload,
  type XmlTreeNode,
} from './browser-structured-shared.js';

export function createTreeRenderer(options: {
  rootData: StructuredPayload;
  defaultOpenDepth: number;
  maxAutoOpenKeys: number;
  onStatus?: (matches: number) => void;
}) {
  const { rootData, defaultOpenDepth, maxAutoOpenKeys, onStatus } = options;

  function renderValueTree(container: HTMLElement, value: unknown, lowerQuery: string, forceExpandAll: boolean | null): { matches: number; expandedCount: number } {
    container.replaceChildren();
    let matches = 0;
    let expandedCount = 0;
    const isRootArrayLarge = Array.isArray(value) && value.length > 10;
    const isRootObjLarge = isPlainObject(value) && Object.keys(value).length > maxAutoOpenKeys;

    function buildPrimitive(val: unknown): HTMLElement {
      if (val === null) return el('span', 'st-null', 'null');
      if (val === undefined) return el('span', 'st-null', 'undefined');
      if (typeof val === 'boolean') return el('span', 'st-bool', String(val));
      if (typeof val === 'number') return el('span', 'st-num', String(val));
      const str = String(val);
      if (str.length > LONG_STRING_THRESHOLD || str.includes('\n')) {
        const wrap = el('span');
        const single = str.replace(/\r?\n/g, '↵');
        const compact = el('span', 'st-str');
        const shown = JSON.stringify(single.length > 120 ? single.slice(0, 120) + '…' : single);
        matches += appendHighlighted(compact, shown, lowerQuery);
        const toggle = el('button', 'st-pill', '展开');
        toggle.type = 'button';
        let expanded = Boolean(lowerQuery && str.toLowerCase().includes(lowerQuery) && str.includes('\n'));
        let block: HTMLPreElement | undefined;
        const sync = () => {
          toggle.textContent = expanded ? '收起' : '展开';
          if (expanded) {
            if (!block) {
              block = el('pre', 'st-str-block');
              appendHighlighted(block, str, lowerQuery);
            }
            compact.hidden = true;
            if (!block.isConnected) wrap.append(block);
          } else {
            compact.hidden = false;
            block?.remove();
          }
        };
        toggle.addEventListener('click', (event) => {
          event.stopPropagation();
          expanded = !expanded;
          sync();
        });
        wrap.append(compact, toggle);
        if (expanded) sync();
        return wrap;
      }
      const span = el('span', 'st-str');
      matches += appendHighlighted(span, JSON.stringify(str), lowerQuery);
      return span;
    }

    function addRowActions(row: HTMLElement, pathSegments: (string | number)[], val: unknown) {
      const actions = el('span', 'st-row-actions');
      const copyVal = el('button', 'st-mini-btn', '复制值');
      copyVal.type = 'button';
      copyVal.addEventListener('click', (event) => {
        event.stopPropagation();
        void copyText(formatCopyValue(val)).then(ok => {
          if (!ok) return;
          copyVal.textContent = '已复制';
          copyVal.classList.add('is-ok');
          setTimeout(() => { copyVal.textContent = '复制值'; copyVal.classList.remove('is-ok'); }, 1200);
        });
      });
      const copyPath = el('button', 'st-mini-btn', '路径');
      copyPath.type = 'button';
      copyPath.title = formatJsonPath(pathSegments);
      copyPath.addEventListener('click', (event) => {
        event.stopPropagation();
        void copyText(formatJsonPath(pathSegments)).then(ok => {
          if (!ok) return;
          copyPath.textContent = '已复制';
          copyPath.classList.add('is-ok');
          setTimeout(() => { copyPath.textContent = '路径'; copyPath.classList.remove('is-ok'); }, 1200);
        });
      });
      actions.append(copyVal, copyPath);
      row.append(actions);
    }

    function buildNode(val: unknown, key: string | number | undefined, depth: number, pathSegments: (string | number)[]): HTMLElement | undefined {
      const keyLabel = key === undefined ? undefined : String(key);
      if (lowerQuery && !valueMatchesQuery(val, lowerQuery, keyLabel)) return undefined;

      const isObject = typeof val === 'object' && val !== null;
      if (!isObject) {
        const node = el('div', 'st-node');
        const row = el('div', 'st-row');
        row.append(el('span', 'st-spacer'));
        const content = el('span', 'st-content');
        if (key !== undefined) {
          const kSpan = el('span', typeof key === 'number' ? 'st-idx' : 'st-key');
          matches += appendHighlighted(kSpan, String(key), lowerQuery);
          content.append(kSpan, el('span', 'st-colon', ':'));
        }
        content.append(buildPrimitive(val));
        row.append(content);
        addRowActions(row, pathSegments, val);
        node.append(row);
        return node;
      }

      const isArr = Array.isArray(val);
      const entries: [string | number, unknown][] = isArr
        ? val.map((item, idx) => [idx, item])
        : ownEntries(val as Record<string, unknown>);
      const count = entries.length;

      let shouldOpen = false;
      if (lowerQuery) {
        shouldOpen = count > 0 && expandedCount < MAX_EXPAND_ALL_NODES;
      } else if (forceExpandAll === true) {
        shouldOpen = count > 0 && expandedCount < MAX_EXPAND_ALL_NODES;
      } else if (forceExpandAll === false) {
        shouldOpen = depth === 0 && count > 0;
      } else {
        if (depth === 0) shouldOpen = count > 0;
        else if (depth < defaultOpenDepth && !isRootArrayLarge && !isRootObjLarge && count <= maxAutoOpenKeys) shouldOpen = true;
      }

      const node = el('div', 'st-node');
      const row = el('div', 'st-row st-row-summary');
      const toggle = el('button', 'st-toggle');
      toggle.type = 'button';
      toggle.setAttribute('aria-label', shouldOpen ? '折叠' : '展开');
      toggle.append(svgIcon('M6 4l4 4-4 4'));
      if (count === 0) toggle.style.visibility = 'hidden';

      const content = el('span', 'st-content');
      if (key !== undefined) {
        const kSpan = el('span', typeof key === 'number' ? 'st-idx' : 'st-key');
        matches += appendHighlighted(kSpan, String(key), lowerQuery);
        content.append(kSpan, el('span', 'st-colon', ':'));
      }
      const openBrace = el('span', 'st-brace', isArr ? '[' : '{');
      const countSpan = el('span', 'st-count', String(count));
      content.append(openBrace, countSpan);

      if (count > 0) {
        const preview = el('span', 'st-inline-preview', singleLinePreview(val));
        content.append(preview);
      } else {
        content.append(el('span', 'st-brace', isArr ? ']' : '}'));
      }

      row.append(toggle, content);
      addRowActions(row, pathSegments, val);
      node.append(row);

      let childrenWrap: HTMLDivElement | undefined;
      let closingBrace: HTMLDivElement | undefined;
      let built = false;

      const setOpen = (open: boolean) => {
        if (count === 0) return;
        node.classList.toggle('is-open', open);
        toggle.setAttribute('aria-label', open ? '折叠' : '展开');
        if (open) {
          if (!built) {
            built = true;
            childrenWrap = el('div', 'st-children');
            for (let i = 0; i < entries.length; i++) {
              const [ck, cv] = entries[i]!;
              const childNode = buildNode(cv, ck, depth + 1, [...pathSegments, ck]);
              if (childNode) childrenWrap.append(childNode);
            }
            closingBrace = el('div', 'st-close-brace', isArr ? ']' : '}');
          }
          if (childrenWrap && !childrenWrap.isConnected) node.append(childrenWrap);
          if (closingBrace && !closingBrace.isConnected) node.append(closingBrace);
        } else {
          childrenWrap?.remove();
          closingBrace?.remove();
        }
      };

      row.addEventListener('click', () => {
        if (count === 0 || window.getSelection()?.toString()) return;
        setOpen(!node.classList.contains('is-open'));
      });

      if (shouldOpen) {
        expandedCount++;
        setOpen(true);
      }
      return node;
    }

    const built = buildNode(value, undefined, 0, []);
    if (built) container.append(built);
    else container.append(el('div', 'st-empty', '没有匹配的字段或内容'));
    onStatus?.(matches);
    return { matches, expandedCount };
  }

  function renderXmlTree(container: HTMLElement, nodes: (XmlTreeNode | string)[], lowerQuery: string, forceExpandAll: boolean | null): { matches: number; expandedCount: number } {
    container.replaceChildren();
    let matches = 0;
    let expandedCount = 0;

    function buildXml(item: XmlTreeNode | string, depth: number): HTMLElement | undefined {
      if (lowerQuery && !xmlMatchesQuery(item, lowerQuery)) return undefined;
      if (typeof item === 'string') {
        const node = el('div', 'st-node');
        const row = el('div', 'st-row');
        row.append(el('span', 'st-spacer'));
        const span = el('span', 'st-str');
        matches += appendHighlighted(span, item, lowerQuery);
        row.append(span);
        node.append(row);
        return node;
      }

      const hasChildren = item.children.length > 0;
      const singleText = item.children.length === 1 && typeof item.children[0] === 'string' ? item.children[0] : undefined;
      let shouldOpen = false;
      if (lowerQuery) shouldOpen = hasChildren && singleText === undefined && expandedCount < MAX_EXPAND_ALL_NODES;
      else if (forceExpandAll === true) shouldOpen = hasChildren && singleText === undefined && expandedCount < MAX_EXPAND_ALL_NODES;
      else if (forceExpandAll === false) shouldOpen = depth === 0 && hasChildren && singleText === undefined;
      else shouldOpen = depth < 2 && hasChildren && singleText === undefined;

      const node = el('div', 'st-node');
      const row = el('div', 'st-row st-row-summary');
      const toggle = el('button', 'st-toggle');
      toggle.type = 'button';
      toggle.append(svgIcon('M6 4l4 4-4 4'));
      if (!hasChildren || singleText !== undefined) toggle.style.visibility = 'hidden';

      const content = el('span', 'st-content');
      content.append(el('span', 'st-brace', '<'));
      const tagSpan = el('span', 'st-tag');
      matches += appendHighlighted(tagSpan, item.tag, lowerQuery);
      content.append(tagSpan);

      if (item.attrs) {
        for (const [ak, av] of item.attrs) {
          content.append(document.createTextNode(' '));
          const nameSpan = el('span', 'st-attr-name');
          matches += appendHighlighted(nameSpan, ak, lowerQuery);
          content.append(nameSpan, el('span', 'st-brace', '='));
          const valSpan = el('span', 'st-attr-val');
          matches += appendHighlighted(valSpan, JSON.stringify(av), lowerQuery);
          content.append(valSpan);
        }
      }

      if (!hasChildren) {
        content.append(el('span', 'st-brace', ' />'));
      } else if (singleText !== undefined) {
        content.append(el('span', 'st-brace', '>'));
        const textSpan = el('span', 'st-str');
        matches += appendHighlighted(textSpan, singleText, lowerQuery);
        content.append(textSpan, el('span', 'st-brace', `</${item.tag}>`));
      } else {
        content.append(el('span', 'st-brace', '>'));
        content.append(el('span', 'st-count', String(item.children.length)));
        content.append(el('span', 'st-inline-preview', `… </${item.tag}>`));
      }

      row.append(toggle, content);
      node.append(row);

      let childrenWrap: HTMLDivElement | undefined;
      let closingTag: HTMLDivElement | undefined;
      let built = false;

      const setOpen = (open: boolean) => {
        if (!hasChildren || singleText !== undefined) return;
        node.classList.toggle('is-open', open);
        if (open) {
          if (!built) {
            built = true;
            childrenWrap = el('div', 'st-children');
            for (const child of item.children) {
              const childEl = buildXml(child, depth + 1);
              if (childEl) childrenWrap.append(childEl);
            }
            closingTag = el('div', 'st-close-brace');
            closingTag.append(el('span', 'st-brace', '</'), el('span', 'st-tag', item.tag), el('span', 'st-brace', '>'));
          }
          if (childrenWrap && !childrenWrap.isConnected) node.append(childrenWrap);
          if (closingTag && !closingTag.isConnected) node.append(closingTag);
        } else {
          childrenWrap?.remove();
          closingTag?.remove();
        }
      };

      if (hasChildren && singleText === undefined) {
        row.addEventListener('click', () => {
          if (window.getSelection()?.toString()) return;
          setOpen(!node.classList.contains('is-open'));
        });
      }
      if (shouldOpen) {
        expandedCount++;
        setOpen(true);
      }
      return node;
    }

    let count = 0;
    for (const rootNode of nodes) {
      const elNode = buildXml(rootNode, 0);
      if (elNode) { container.append(elNode); count++; }
    }
    if (!count) container.append(el('div', 'st-empty', '没有匹配的节点或内容'));
    onStatus?.(matches);
    return { matches, expandedCount };
  }

  return {
    render(container: HTMLElement, lowerQuery: string, forceExpandAll: boolean | null) {
      if (rootData.kind === 'xml') return renderXmlTree(container, rootData.xml ?? [], lowerQuery, forceExpandAll);
      return renderValueTree(container, rootData.value, lowerQuery, forceExpandAll);
    },
  };
}
