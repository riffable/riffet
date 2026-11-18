import { expect, it, vi } from 'vitest';
import { z } from 'zod/v4';
import { compareSnapshots, type ContractSnapshot } from '../../../../packages/contracts/src/schema/compat.js';
import { defineRead, defineSettingCommand } from '../assistant-capability.js';
import { CapabilityCatalog, discoveryTools } from './capability-catalog.js';

it('keeps discovery stable as domains grow and never dispatches settings through read', async () => {
  const read = defineRead('plugins.list', 'Find plugins', ['插件'], z.strictObject({}), sessionId => ({ sessionId }));
  const handler = vi.fn(() => ({ persisted:true }));
  const command = defineSettingCommand('setting_set','Write a preference',z.strictObject({ sourceTurn:z.string() }),handler);
  const initial = new CapabilityCatalog([read],[command]);
  expect(() => new CapabilityCatalog([read,read])).toThrow(/Duplicate/);
  expect(() => initial.call('capability_read',{id:'setting_set',arguments:{sourceTurn:'forged'}},'main')).toThrow(/No such/);
  expect(handler).not.toHaveBeenCalled();
  expect(() => initial.call('capability_read',{id:'plugins.list',arguments:{user:'other'}},'main')).toThrow();
  const extra = defineRead('plugins.inspect','Read activation', ['插件'],z.strictObject({}), () => ({}));
  const upgraded = new CapabilityCatalog([read,extra],[command]);
  const page = (await upgraded.call('capability_find',{query:'插件',limit:1},'main')) as {nextCursor:string};
  expect(await upgraded.call('capability_find',{domain:'plugins',cursor:page.nextCursor},'main')).toMatchObject({capabilities:[{id:'plugins.list'}]});
  expect(await upgraded.call('capability_read',{id:'plugins.list'},'main')).toEqual({sessionId:'main'});

  // The same compatibility checker guards public HTTP request schemas. Existing clients can omit
  // optional filters and pass a formerly valid page size as new domains and options are released.
  const current: ContractSnapshot = {version:'1',contracts:Object.fromEntries(discoveryTools.map(tool=>[tool.name,{direction:'request',schema:tool.inputSchema}]))};
  const released: ContractSnapshot = {version:'1', contracts:{
    capability_find:{direction:'request',schema:{type:'object',properties:{domain:{type:'string',minLength:1,maxLength:80},query:{type:'string',minLength:1,maxLength:200},cursor:{type:'string',minLength:1,maxLength:160},limit:{type:'integer',minimum:1,maximum:50}}}},
    capability_read:{direction:'request',schema:{type:'object',required:['id'],properties:{id:{type:'string',minLength:1,maxLength:160},arguments:{type:'object'}}}},
  }};
  expect(compareSnapshots(released,current)).toEqual([]);
});
