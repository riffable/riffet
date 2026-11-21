export function activate(host) {
  let count = 0;
  let updatedAt = new Date().toISOString();
  return {
    queries: {
      'example.workbench-sample/summary': {
        async run() {
          return { count, updatedAt };
        },
      },
    },
    commands: {
      'example.workbench-sample/bump': {
        async run() {
          count += 1;
          updatedAt = new Date().toISOString();
          host.views?.invalidate('summary');
          return { kind: 'done' };
        },
      },
    },
  };
}

export default { activate };
