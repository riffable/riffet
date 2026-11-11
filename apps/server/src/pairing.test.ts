import { describe,it,expect } from 'vitest';
import { createPairingCode,pendingPairingCodes,redeemPairingCode } from './pairing.js';

describe('pairing codes',()=>{
  it('mints an unambiguous code and redeems it exactly once',()=>{
    const pairing=createPairingCode();
    expect(pairing.code).toMatch(/^[23456789ABCDEFGHJKMNPQRSTVWXYZ]{8}$/);
    expect(pairing.expiresAt).toBeGreaterThan(Date.now());
    expect(redeemPairingCode(pairing.code)).toBe(true);
    expect(redeemPairingCode(pairing.code)).toBe(false);
  });
  it('accepts lowercase and whitespace-padded submissions',()=>{
    const pairing=createPairingCode();
    expect(redeemPairingCode(`  ${pairing.code.toLowerCase()}  `)).toBe(true);
    expect(redeemPairingCode(pairing.code)).toBe(false);
  });
  it('rejects and prunes an expired code',()=>{
    const pairing=createPairingCode(0);
    expect(pendingPairingCodes()).toBe(0);
    expect(redeemPairingCode(pairing.code)).toBe(false);
  });
  it('rejects garbage without consuming a live code',()=>{
    const pairing=createPairingCode();
    for(const value of [undefined,null,42,{},[],[pairing.code],'','   ','!!!!!!!!',pairing.code.slice(0,7),pairing.code+'A',pairing.code.toUpperCase()+'Z'])
      expect(redeemPairingCode(value)).toBe(false);
    expect(redeemPairingCode(pairing.code)).toBe(true);
  });
  it('always mints a well-formed code, even when rejection sampling refills',()=>{
    for(let index=0;index<500;index++)expect(createPairingCode(0).code).toMatch(/^[23456789ABCDEFGHJKMNPQRSTVWXYZ]{8}$/);
    expect(pendingPairingCodes()).toBe(0);
  });
});
