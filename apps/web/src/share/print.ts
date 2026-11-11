/** Display equations cannot wrap. Reduce their type size rather than cropping wide matrices. */
export function fitPrintMath(root: HTMLElement): void {
  const equations = [...root.querySelectorAll<HTMLElement>('.katex-display')];
  for (const equation of equations) equation.style.removeProperty('font-size');
  for (const equation of equations) {
    const content = equation.querySelector<HTMLElement>('.katex-html');
    const available = equation.clientWidth;
    const width = content?.getBoundingClientRect().width ?? equation.scrollWidth;
    if (available > 1 && width > available) {
      const size = Number.parseFloat(getComputedStyle(equation).fontSize);
      equation.style.fontSize = `${size * (available - 1) / width}px`;
    }
  }
}

/** Wait for the actual render, rather than a network-idle timer (graphs render in isolated frames). */
export async function preparePrint(root: HTMLElement, signal: AbortSignal, fontSetup: Promise<unknown>): Promise<void> {
  const check = () => {
    signal.throwIfAborted();
    if (!root.isConnected) throw new DOMException('Print document was closed', 'AbortError');
  };
  const abortable = <T>(promise: Promise<T>): Promise<T> => new Promise((resolve, reject) => {
    check();
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
  const images = () => [...root.querySelectorAll('img')];
  const pending = () => root.querySelector('[data-print-pending]') !== null || images().some(image => !image.complete);

  await abortable(fontSetup);
  for (;;) {
    check();
    await abortable(new Promise<void>(resolve => {
      const observer = new MutationObserver(read);
      function read() { if (!pending()) { dispose(); resolve(); } }
      function dispose() {
        observer.disconnect();
        root.removeEventListener('load', read, true);
        root.removeEventListener('error', read, true);
        signal.removeEventListener('abort', dispose);
      }
      observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-print-pending', 'src', 'class'] });
      root.addEventListener('load', read, true);
      root.addEventListener('error', read, true);
      signal.addEventListener('abort', dispose, { once: true });
      read();
    }));
    // Let React commit loaded renderers. Offscreen print frames may suspend animation frames,
    // so a task also releases the wait; layout/font/image checks below still establish readiness.
    await abortable(new Promise<void>(resolve => {
      let frame = 0;
      const done = () => {
        window.clearTimeout(timer);
        cancelAnimationFrame(frame);
        signal.removeEventListener('abort', done);
        resolve();
      };
      const timer = window.setTimeout(done, 100);
      frame = requestAnimationFrame(() => { frame = requestAnimationFrame(done); });
      signal.addEventListener('abort', done, { once: true });
    }));
    await abortable(document.fonts.ready);
    const current = images();
    await abortable(Promise.all(current.map(image => image.decode().catch(() => {
      // Failed images have an explicit placeholder (PrintImage); never replace them with blank space.
      if (image.isConnected) throw new Error(image.alt || 'Image failed to load');
    }))));
    check();
    if (!pending() && current.length === images().length && current.every(image => image.isConnected) && document.fonts.status === 'loaded') {
      fitPrintMath(root);
      return;
    }
  }
}
