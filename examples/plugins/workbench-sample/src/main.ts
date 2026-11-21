import { connect } from '@riffet/plugin-web/bridge-client';

async function start() {
  const root = document.getElementById('root')!;
  root.style.padding = 'var(--riffet-space-5)';
  const count = document.createElement('p');
  const bump = document.createElement('button');
  bump.textContent = '+1';
  bump.disabled = true;
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  root.append(count, bump, status);

  const showError = (error: unknown) => { status.textContent = error instanceof Error ? error.message : String(error); };
  try {
    const bridge = await connect({ requiredMethods: ['plugin.query', 'commands.execute'] });
    let refreshing = false;
    let invalidated = false;
    const refresh = async () => {
      invalidated = true;
      if (refreshing) return;
      refreshing = true;
      while (invalidated) {
        invalidated = false;
        try {
          const summary = await bridge.call('plugin.query', { id: 'example.workbench-sample/summary' }) as { count: number };
          count.textContent = String(summary.count);
          status.textContent = '';
        } catch (error) {
          showError(error);
        }
      }
      refreshing = false;
    };
    bridge.on('plugin.data', () => { void refresh(); });
    bump.addEventListener('click', async () => {
      bump.disabled = true;
      status.textContent = '';
      try {
        await bridge.call('commands.execute', { id: 'example.workbench-sample/bump' });
      } catch (error) {
        showError(error);
      } finally {
        bump.disabled = false;
      }
    });
    await refresh();
    bump.disabled = false;
  } catch (error) {
    showError(error);
  }
}

void start();
