import { describe, expect, it } from 'vitest';
import { commandActions } from './command-actions.js';

describe('commandActions', () => {
  it('names what reading and searching commands look at', () => {
    expect(commandActions(`sed -n 1,80p src/a.ts; echo ---; cat src/b.ts | head -40`)?.map(action => [action.type, action.path]))
      .toEqual([['read', 'src/a.ts'], ['read', 'src/b.ts']]);
    expect(commandActions(`cd apps/web && grep -rn "foo\\|bar" src --include='*.ts' 2>/dev/null | head -20`))
      .toEqual([{ type: 'search', command: `grep -rn foo\\|bar src --include=*.ts | head -20`, query: 'foo\\|bar', path: 'apps/web/src' }]);
    expect(commandActions(`rg -n foo \\\n  src | sed 's/^/  /'`)?.map(action => [action.type, action.path])).toEqual([['search', 'src']]);
    expect(commandActions('find . -name "*.swift" | wc -l')?.map(action => [action.type, 'query' in action ? action.query : undefined])).toEqual([['search', '*.swift']]);
    expect(commandActions('ls')?.map(action => action.type)).toEqual(['listFiles']);
  });

  it('leaves a command as written when any part of it is not a read', () => {
    const kept = [
      'pnpm test', 'cat a | tee b', 'cat a > b', `sed -i '' s/a/b/ f`, `sed -n 's/a/b/w out' f`, 'ls | xargs rm', 'tail -f log',
      'find . -name x -delete', 'cat <<EOF\nx\nEOF', 'echo $(cat a)', 'cat a; rm b', 'cd $DIR && cat a', 'rg --pre ./x foo', 'echo hi',
      'git status', 'cat a &', `grep x a | sort -o out`, `ls | sed 's/a/b/e'`, `ls | sed 's/a/b/wout'`, 'ls | rg --pre ./x foo',
      'git grep -O vim foo', 'tree -o out', './cat a', 'ls | ./sort',
    ];
    expect(kept.filter(command => commandActions(command) !== undefined)).toEqual([]);
  });
});
