import { randomBytes, timingSafeEqual } from 'node:crypto';

export interface PairingCode { code: string; expiresAt: number }

/** Crockford-ish base32: no I, L, O or U, so a code read aloud is unambiguous. */
const ALPHABET='23456789ABCDEFGHJKMNPQRSTVWXYZ';
const DEFAULT_TTL_MS=5*60_000;
/**
 * In memory on purpose: restarting the server invalidates every outstanding code. Codes are kept per
 * purpose, so a device pairing code can never bind a chat account, nor the reverse.
 */
const pools=new Map<string,Map<string,PairingCode>>();
const DEVICE='device';

export function createPairingCode(ttlMs=DEFAULT_TTL_MS,purpose=DEVICE): PairingCode {
  prune();
  const code=randomCode();
  const entry={code,expiresAt:Date.now()+ttlMs};
  pool(purpose).set(code,entry);
  return entry;
}

export function redeemPairingCode(code: unknown,purpose=DEVICE): boolean {
  const now=Date.now();
  prune(now);
  const pending=pool(purpose);
  const submitted=Buffer.from(typeof code==='string'?code.trim().toUpperCase():'');
  for(const entry of pending.values()){
    const stored=Buffer.from(entry.code);
    if(stored.length!==submitted.length||!timingSafeEqual(stored,submitted))continue;
    pending.delete(entry.code);
    return true;
  }
  return false;
}

export function pendingPairingCodes(purpose=DEVICE): number { prune(); return pool(purpose).size; }

function pool(purpose: string): Map<string,PairingCode> {
  let pending=pools.get(purpose);
  if(!pending)pools.set(purpose,pending=new Map());
  return pending;
}
function prune(now=Date.now()) {
  for(const [purpose,pending] of pools){
    for(const [code,entry] of pending)if(entry.expiresAt<=now)pending.delete(code);
    if(!pending.size)pools.delete(purpose);
  }
}
/** Rejection sampling: 240 is the largest multiple of the 30-symbol alphabet, so no symbol is favoured. */
function randomCode(): string {
  let code='';
  while(code.length<8){
    for(const byte of randomBytes(8)){
      if(byte>=240)continue;
      code+=ALPHABET[byte%ALPHABET.length];
      if(code.length===8)break;
    }
  }
  return code;
}
