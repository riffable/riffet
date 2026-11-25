import { describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { argsFor, configure, resolveLaunchOptions, saveLaunchConfig, validateLaunchOptions, serve, type LaunchOptions } from './launch.js';
import { createApp } from '../app.js';
vi.mock('../app.js',()=>({createApp:vi.fn()}));
describe('persistent server launch configuration',()=>{
  function options(args:string[]=[],stateDir='/tmp/riffet-launch-test-state') {
    const command=configure(new Command());
    command.parse(args,{from:'user'});
    return {command,opts:{...command.opts(),stateDir} as LaunchOptions};
  }
  const saved=['serve','--host','0.0.0.0','--port','4337','--cli','custom-agent','--no-mdns'];
  it('restores the LAN host and authentication after stop/start without copying the old state directory',()=>{
    const {command,opts}=options([],'/tmp/different-riffet-state');
    const restored=resolveLaunchOptions(opts,command,saved);
    expect(restored).toMatchObject({host:'0.0.0.0',port:'4337',auth:true,cli:'custom-agent',mdns:false,stateDir:'/tmp/different-riffet-state'});
  });
  it('first launch: this computer without a token, any other address with one',()=>{
    expect(resolveLaunchOptions(options().opts,options().command)).toMatchObject({host:'127.0.0.1',port:'4337',auth:false});
    const lan=options(['--host','0.0.0.0']);
    expect(resolveLaunchOptions(lan.opts,lan.command)).toMatchObject({host:'0.0.0.0',auth:true});
    const local=options(['--auth']);
    expect(resolveLaunchOptions(local.opts,local.command)).toMatchObject({host:'127.0.0.1',auth:true});
  });
  it('keeps a saved token-free loopback launch, and asks for the token once a LAN address is given',()=>{
    const loopback=['serve','--host','127.0.0.1','--port','4337','--cli','cursor-agent','--no-auth'];
    const plain=options();
    expect(resolveLaunchOptions(plain.opts,plain.command,loopback)).toMatchObject({host:'127.0.0.1',auth:false});
    const lan=options(['--host','0.0.0.0']);
    expect(resolveLaunchOptions(lan.opts,lan.command,loopback)).toMatchObject({host:'0.0.0.0',auth:true});
  });
  it('lets explicit restart arguments override saved launch values',()=>{
    const {command,opts}=options(['--host','127.0.0.1','--port','4444','--cli','new-agent','--no-auth','--mdns']);
    const restored=resolveLaunchOptions(opts,command,saved);
    expect(restored).toMatchObject({host:'127.0.0.1',port:'4444',cli:'new-agent',auth:false,mdns:true});
  });
  it('rejects a LAN/no-auth restart configuration before shutdown',()=>{
    const {command,opts}=options(['--host','0.0.0.0','--no-auth']);
    expect(()=>validateLaunchOptions(resolveLaunchOptions(opts,command,saved))).toThrow('Token-free access only works');
  });
  it('rejects a missing workspace before shutdown',()=>{
    const {command,opts}=options(['--workspace','/private/tmp/riffet-missing-workspace-for-restart-test']);
    expect(()=>validateLaunchOptions(resolveLaunchOptions(opts,command,saved))).toThrow('--workspace');
  });
  it('only replaces saved launch intent after a successful listen',async()=>{
    const stateDir=mkdtempSync(join(tmpdir(),'riffet-launch-test-'));
    const initial=options([],stateDir).opts;
    try {
      saveLaunchConfig(initial,saved);
      const before=readFileSync(join(stateDir,'server-config.json'),'utf8');
      vi.mocked(createApp).mockResolvedValueOnce({app:{listen:vi.fn().mockRejectedValue(new Error('EADDRINUSE')),close:vi.fn().mockResolvedValue(undefined)}} as unknown as Awaited<ReturnType<typeof createApp>>);
      await expect(serve({...initial,port:'4999'})).rejects.toThrow('EADDRINUSE');
      expect(readFileSync(join(stateDir,'server-config.json'),'utf8')).toBe(before);
      expect(existsSync(join(stateDir,'daemon.json'))).toBe(false);
      expect(existsSync(join(stateDir,'server.lock'))).toBe(false);
    }finally{rmSync(stateDir,{recursive:true,force:true});}
  });
  it('validates and preserves --profile and --idle-exit in saved launch args',()=>{
    const stateDir=mkdtempSync(join(tmpdir(),'riffet-launch-profile-'));
    try {
      const {command,opts}=options(['--profile','lite','--idle-exit','30m'],stateDir);
      const resolved=resolveLaunchOptions(opts,command);
      expect(()=>validateLaunchOptions(resolved)).not.toThrow();
      const args=argsFor(resolved);
      expect(args).toContain('--profile');
      expect(args).toContain('lite');
      expect(args).toContain('--idle-exit');
      expect(args).toContain('30m');

      const badProfile=options(['--profile','ultra'],stateDir);
      expect(()=>validateLaunchOptions(badProfile.opts)).toThrow('--profile');
      const badIdle=options(['--idle-exit','forever'],stateDir);
      expect(()=>validateLaunchOptions(badIdle.opts)).toThrow('--idle-exit');
    }finally{rmSync(stateDir,{recursive:true,force:true});}
  });
});
