import { lstatSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cursorCommand, resolveCursorLaunchProfile } from './cli-driver.js';

const directories:string[]=[];
afterEach(()=>{for(const dir of directories.splice(0))rmSync(dir,{recursive:true,force:true});});
function temporary():string {
  const dir=mkdtempSync(join(tmpdir(),'riffet-relay-'));
  directories.push(dir);
  return dir;
}
const relayKey='br-'+ 'a'.repeat(32);
const endpoint='http://localhost:48080';

describe('Cursor Byte Relay transport',()=>{
  it('uses one gateway address for API and agent and prepares HTTP/1 without saving the key',()=>{
    const configDir=temporary();
    const profile=resolveCursorLaunchProfile({executable:process.execPath,configDir,apiEndpoint:endpoint},undefined,relayKey);
    const command=cursorCommand(profile,['--list-models']);
    expect(command.args).toEqual(['--endpoint',endpoint,'--agent-endpoint',endpoint,'--list-models']);
    expect(command.env.CURSOR_API_KEY).toBe(relayKey);
    expect(command.env.AGENT_CLI_CREDENTIAL_STORE).toBe('memory');
    const content=readFileSync(join(configDir,'cli-config.json'),'utf8');
    expect(JSON.parse(content)).toEqual({network:{useHttp1ForAgent:true}});
    expect(content).not.toContain(relayKey);
    expect(statSync(join(configDir,'cli-config.json')).mode&0o777).toBe(0o600);
  });

  it('preserves unrelated CLI settings and does not rewrite already prepared settings',()=>{
    const configDir=temporary(),path=join(configDir,'cli-config.json');
    writeFileSync(path,JSON.stringify({model:'alpha',permissions:{allow:['Read']},network:{custom:'keep',useHttp1ForAgent:false}}));
    const profile=resolveCursorLaunchProfile({executable:process.execPath,configDir,apiEndpoint:endpoint},undefined,relayKey);
    cursorCommand(profile,[]);
    expect(JSON.parse(readFileSync(path,'utf8'))).toEqual({model:'alpha',permissions:{allow:['Read']},network:{custom:'keep',useHttp1ForAgent:true}});
    const modified=statSync(path).mtimeMs;
    cursorCommand(profile,[]);
    expect(statSync(path).mtimeMs).toBe(modified);
  });

  it('uses the relay address even with a stale agent endpoint and supports an environment key',()=>{
    const configDir=temporary();
    const profile=resolveCursorLaunchProfile({executable:process.execPath,configDir,apiEndpoint:endpoint,agentEndpoint:'http://localhost:48081'});
    expect(cursorCommand(profile,[],{CURSOR_API_KEY:relayKey}).args).toEqual(['--endpoint',endpoint,'--agent-endpoint',endpoint]);
  });

  it('leaves other gateway settings and commands without credentials untouched',()=>{
    const configDir=temporary(),path=join(configDir,'cli-config.json');
    writeFileSync(path,'{"network":{"useHttp1ForAgent":false}}\n');
    const profile=resolveCursorLaunchProfile({executable:process.execPath,configDir,apiEndpoint:endpoint},undefined,'other-provider-key');
    expect(cursorCommand(profile,[]).args).toEqual(['--endpoint',endpoint]);
    const relay=resolveCursorLaunchProfile({executable:process.execPath,configDir,apiEndpoint:endpoint},undefined,relayKey);
    expect(cursorCommand(relay,[],{}, {includeApiKey:false}).env.CURSOR_API_KEY).toBeUndefined();
    expect(readFileSync(path,'utf8')).toBe('{"network":{"useHttp1ForAgent":false}}\n');
  });

  it('reports malformed CLI settings without overwriting them',()=>{
    const configDir=temporary(),path=join(configDir,'cli-config.json');
    writeFileSync(path,'{invalid-json');
    const profile=resolveCursorLaunchProfile({executable:process.execPath,configDir,apiEndpoint:endpoint},undefined,relayKey);
    expect(()=>cursorCommand(profile,[])).toThrow('Cannot prepare Byte Relay transport');
    expect(readFileSync(path,'utf8')).toBe('{invalid-json');
  });

  it('prepares the same configuration directory that the frozen relay profile launches with',()=>{
    const configDir=temporary(),differentDir=temporary();
    const profile=resolveCursorLaunchProfile({executable:process.execPath,configDir,apiEndpoint:endpoint},undefined,relayKey);
    const command=cursorCommand(profile,[],{CURSOR_CONFIG_DIR:differentDir});
    expect(command.env.CURSOR_CONFIG_DIR).toBe(configDir);
    expect(JSON.parse(readFileSync(join(command.env.CURSOR_CONFIG_DIR!,'cli-config.json'),'utf8')).network.useHttp1ForAgent).toBe(true);
  });

  it.skipIf(process.platform==='win32')('preserves a managed configuration symlink and updates its target',()=>{
    const configDir=temporary(),targetDir=temporary();
    const path=join(configDir,'cli-config.json'),target=join(targetDir,'managed-config.json');
    writeFileSync(target,JSON.stringify({model:'alpha',network:{useHttp1ForAgent:false}}),{mode:0o600});
    symlinkSync(target,path);
    const profile=resolveCursorLaunchProfile({executable:process.execPath,configDir,apiEndpoint:endpoint},undefined,relayKey);
    cursorCommand(profile,[]);
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(target,'utf8'))).toEqual({model:'alpha',network:{useHttp1ForAgent:true}});
  });
});
