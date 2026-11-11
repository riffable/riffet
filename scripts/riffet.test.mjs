import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

let fixture;
before(()=>{
  fixture=mkdtempSync(join(tmpdir(),'riffet-wrapper-'));
  mkdirSync(join(fixture,'scripts'));mkdirSync(join(fixture,'dist'));
  copyFileSync('scripts/riffet.mjs',join(fixture,'scripts/riffet.mjs'));
  writeFileSync(join(fixture,'package.json'),'{"type":"module"}');
  writeFileSync(join(fixture,'dist/cli.js'),'console.log(JSON.stringify(process.argv.includes("--report-cwd") ? {args:process.argv.slice(2),cwd:process.cwd()} : process.argv.slice(2)))');
  symlinkSync(resolve('node_modules'),join(fixture,'node_modules'),'dir');
});
after(()=>rmSync(fixture,{recursive:true,force:true}));
function args(...values){
  const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^RIFFET_/.test(key)));
  return JSON.parse(execFileSync(process.execPath,[join(fixture,'scripts/riffet.mjs'),...values,'--state-dir',join(fixture,'state')],{env,encoding:'utf8'}));
}
test('pair forwards state-dir and explicit json without printing a login token',()=>{
  const result=args('pair','--json');
  assert.deepEqual(result,['pair','--state-dir',join(fixture,'state'),'--json']);
});
test('plugin forwards management options without launch overrides and delegates help',()=>{
  assert.deepEqual(args('plugin','install','./plugin.tgz','--trusted','--yes'),['plugin','install','./plugin.tgz','--trusted','--yes','--state-dir',join(fixture,'state')]);
  assert.deepEqual(args('plugin','pack','--help'),['plugin','pack','--help']);
});
test('plugin pack preserves the caller directory and keeps global state out of build options',()=>{
  const result=JSON.parse(execFileSync(process.execPath,[join(fixture,'scripts/riffet.mjs'),'--state-dir',join(fixture,'state'),'plugin','pack','.','--out','dist/plugin.zip','--report-cwd'],{cwd:fixture,encoding:'utf8'}));
  assert.deepEqual(result.args,['plugin','pack','.','--out','dist/plugin.zip','--report-cwd']);
  assert.equal(result.cwd,realpathSync(fixture));
});
test('update forwards its check/app flags and selected state directory without launch overrides',()=>{
  assert.deepEqual(args('update','--check','--json','--app'),['update','--state-dir',join(fixture,'state'),'--check','--json','--app']);
  assert.deepEqual(args('update','--app','--configuration','Debug'),['update','--state-dir',join(fixture,'state'),'--app','--configuration','Debug']);
});
test('LAN start automatically enables auth while local start remains compatible',()=>{
  assert.ok(args('start','--host','0.0.0.0').includes('--auth'));
  assert.ok(args('start').includes('--no-auth'));
  assert.ok(args('start','--auth').includes('--auth'));
  assert.ok(args('start','--host','0.0.0.0','--no-auth').includes('--no-auth'));
});
test('restart sends only explicit configuration overrides',()=>{
  mkdirSync(join(fixture,'state'),{recursive:true});
  const record=join(fixture,'state/daemon.json');
  writeFileSync(record,JSON.stringify({host:'0.0.0.0',port:4337}));
  const plain=args('restart');
  for(const flag of ['--host','--port','--cli','--auth','--no-auth'])assert.ok(!plain.includes(flag));
  const explicit=args('restart','--host','0.0.0.0','--port','4338','--auth');
  assert.ok(explicit.includes('--auth'));
  assert.equal(explicit[explicit.indexOf('--host')+1],'0.0.0.0');
  assert.equal(explicit[explicit.indexOf('--port')+1],'4338');
  rmSync(record);
});
test('restart without saved configuration retains the wrapper first-launch defaults',()=>{
  const result=args('restart');
  assert.equal(result[result.indexOf('--port')+1],'4337');
  assert.ok(result.includes('--no-auth'));
});
test('status does not forward pair or json and hides the master token',()=>{
  assert.deepEqual(args('status'),['status','--state-dir',join(fixture,'state'),'--no-token']);
});

test('start after stop retains saved LAN configuration instead of forwarding local defaults',()=>{
  mkdirSync(join(fixture,'state'),{recursive:true});
  const config=join(fixture,'state/server-config.json');
  writeFileSync(config,JSON.stringify({version:1,args:['serve','--host','0.0.0.0','--port','4337']}));
  try {
    const restored=args('start');
    for(const flag of ['--host','--port','--cli','--auth','--no-auth'])assert.ok(!restored.includes(flag));
    const overridden=args('start','--host','127.0.0.1','--no-auth');
    assert.equal(overridden[overridden.indexOf('--host')+1],'127.0.0.1');
    assert.ok(overridden.includes('--no-auth'));
  }finally{rmSync(config);}
});
