import { useCallback, useEffect, useRef, type DragEvent } from 'react';

const EDGE = 32;
const EDGE_STEP = 10;

/**
 * Drag to reorder inside one zone of the tab bar. Only this zone's own tabs are drop targets, so a
 * drop in the other zone does nothing. During the drag the tab's node is moved in the DOM instead of
 * re-rendering, which would remove the drag source and cancel the drag; once it ends the nodes are
 * put back where React left them and the new order is committed through the store.
 */
export function useZoneDrag(commit: (ids: string[]) => void, onStart: () => void, onDesync: () => void) {
  const drag = useRef<{ node: HTMLElement; zone: HTMLElement; saved: Element[]; before: string[]; dropped: boolean } | undefined>(undefined);
  const edgeTimer = useRef<number | undefined>(undefined);
  const stopEdge = () => { window.clearInterval(edgeTimer.current); edgeTimer.current = undefined; };
  useEffect(() => stopEdge, []);

  const idsOf = (zone: HTMLElement) => [...zone.querySelectorAll<HTMLElement>('[data-tab-id][draggable="true"]')].map((node) => node.dataset.tabId!);

  const onDragStart = useCallback((event: DragEvent<HTMLElement>) => {
    const node = (event.target as Element).closest<HTMLElement>('[data-tab-id][draggable="true"]');
    if (!node || !event.currentTarget.contains(node)) return;
    drag.current = { node, zone: event.currentTarget, saved: [...event.currentTarget.children], before: idsOf(event.currentTarget), dropped: false };
    node.classList.add('opacity-35');
    event.dataTransfer.effectAllowed = 'move';
    // A private type: a tab dropped on the composer or any text field must not paste its title.
    event.dataTransfer.setData('application/x-riffet-tab', node.dataset.tabId ?? '');
    onStart();
  }, [onStart]);

  const onDragOver = useCallback((event: DragEvent<HTMLElement>) => {
    const current = drag.current;
    if (!current || current.zone !== event.currentTarget) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    stopEdge();
    // Near either end the zone scrolls itself, so a tab can travel past what is showing.
    const box = current.zone.getBoundingClientRect();
    const direction = event.clientX < box.left + EDGE ? -1 : event.clientX > box.right - EDGE ? 1 : 0;
    if (direction) edgeTimer.current = window.setInterval(() => { current.zone.scrollLeft += direction * EDGE_STEP; }, 16);
    const over = (event.target as Element).closest<HTMLElement>('[data-tab-id][draggable="true"]');
    if (!over || over === current.node || !current.zone.contains(over)) return;
    const nodes = [...current.zone.querySelectorAll<HTMLElement>('[data-tab-id][draggable="true"]')];
    const from = nodes.indexOf(current.node);
    const to = nodes.indexOf(over);
    const rect = over.getBoundingClientRect();
    const after = event.clientX > rect.left + rect.width / 2;
    if ((from < to && !after) || (from > to && after)) return;
    current.zone.insertBefore(current.node, after ? over.nextSibling : over);
  }, []);

  const onDrop = useCallback((event: DragEvent<HTMLElement>) => {
    if (!drag.current || drag.current.zone !== event.currentTarget) return;
    event.preventDefault();
    drag.current.dropped = true;
  }, []);

  const onDragEnd = useCallback(() => {
    const current = drag.current;
    drag.current = undefined;
    stopEdge();
    if (!current) return;
    const after = idsOf(current.zone);
    current.node.classList.remove('opacity-35');
    // A tab React removed mid-drag stays gone; re-appending it would leave a ghost.
    current.zone.append(...current.saved.filter((node) => node.isConnected && node.parentNode === current.zone));
    // A node React added mid-drag (a tab opened, one collapsing, the home tab) now sits out of the
    // order React holds; the zone rebuilds its tabs rather than reconcile against a moved DOM.
    if ([...current.zone.children].some((node) => !current.saved.includes(node))) onDesync();
    if (current.dropped && after.some((id, index) => id !== current.before[index])) commit(after);
  }, [commit, onDesync]);

  return { onDragStart, onDragOver, onDrop, onDragEnd };
}
