import { describe, expect, it } from 'vitest';
import { declarations, parseJvmImports, parseTsImports } from './code-nav.js';

const lines = (text: string, word: string, group: Parameters<typeof declarations>[3]) => declarations(text, 'f', word, group).map(item => item.line);

describe('declaration patterns', () => {
  it('finds Kotlin declarations and not their uses', () => {
    const text = ['class Foo(val bar: Int) {', '  fun String.shout(loud: Boolean) = this', '  private lateinit var baz: Foo', '  val x = shout()', '}', 'typealias Alias = Foo'].join('\n');
    expect(lines(text, 'Foo', 'kotlin')).toEqual([1]);
    expect(lines(text, 'bar', 'kotlin')).toEqual([1]);
    expect(lines(text, 'shout', 'kotlin')).toEqual([2]);
    expect(lines(text, 'baz', 'kotlin')).toEqual([3]);
    expect(lines(text, 'Alias', 'kotlin')).toEqual([6]);
  });

  it('finds Java methods, fields and parameters but not calls', () => {
    const text = ['public class Foo {', '  private final int count;', '  @Override public <T> List<T> load(String key, int count) {', '    return load(key, count);', '    helper.load(key);', '  }', '}'].join('\n');
    expect(lines(text, 'Foo', 'java')).toEqual([1]);
    expect(lines(text, 'load', 'java')).toEqual([3]);
    expect(lines(text, 'count', 'java')).toEqual([2, 3]);
  });

  it('finds TypeScript declarations', () => {
    const text = ['export async function run(job: Job) {', '  const { a, b } = job;', '  run(a);', '}', 'class K { private cache = new Map(); fetch(id: string) { return 1; } }'].join('\n');
    expect(lines(text, 'run', 'ts')).toEqual([1]);
    expect(lines(text, 'b', 'ts')).toEqual([2]);
    expect(lines(text, 'job', 'ts')).toEqual([1]);
  });
});

describe('imports', () => {
  it('parses Kotlin and Java imports', () => {
    expect(parseJvmImports('package a\nimport a.b.C\nimport a.b.D as E\nimport static a.b.F.m;\nimport a.g.*\n')).toEqual([
      { fqn: 'a.b.C', star: false }, { fqn: 'a.b.D', star: false, alias: 'E' }, { fqn: 'a.b.F.m', star: false }, { fqn: 'a.g', star: true },
    ]);
  });

  it('parses TypeScript imports and re-exports', () => {
    const { bindings, stars } = parseTsImports(["import x, { a as b, type C } from './x';", "import * as ns from './ns.js'", "export { d as e } from './d'", "export * from './all'"].join('\n'));
    expect(bindings.map(item => [item.local, item.imported, item.reexport])).toEqual([['x', 'default', false], ['b', 'a', false], ['C', 'C', false], ['ns', '*', false], ['e', 'd', true]]);
    expect(stars).toEqual(['./all']);
  });
});
