import { afterEach,describe,expect,it,vi } from 'vitest';
import { api,requestResponse,setCsrfToken } from './api';

afterEach(()=>{vi.unstubAllGlobals();setCsrfToken('');});
describe('browser auth transport',()=>{
  it('sends normalized launch colours on mutations and reads the current appearance on the next request',async()=>{
    const colours: Record<string,string> = { '--fg':'#222', '--bg':'#fff', '--accent':'#36f' };
    vi.stubGlobal('document',{documentElement:{classList:{contains:()=>false}}});
    vi.stubGlobal('getComputedStyle',()=>({getPropertyValue:(name:string)=>colours[name]??''}));
    const fetcher=vi.fn().mockImplementation(async()=>new Response('{}',{headers:{'content-type':'application/json'}}));
    vi.stubGlobal('fetch',fetcher);
    await requestResponse('/api/sessions',{method:'POST',body:'{}'});
    expect(fetcher.mock.calls[0]![1].headers.get('x-riffet-terminal-appearance')).toBe('#222222;#ffffff');
    colours['--fg']='#eee';colours['--bg']='#111';
    await requestResponse('/api/sessions/session/reopen',{method:'POST',body:'{}'});
    expect(fetcher.mock.calls[1]![1].headers.get('x-riffet-terminal-appearance')).toBe('#eeeeee;#111111');
  });
  it('redeems a code through cookies and uses the returned CSRF for later mutations',async()=>{
    const fetcher=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({authenticated:true,tokenRequired:true,csrfToken:'paired-csrf'}),{headers:{'content-type':'application/json'}}))
      .mockResolvedValueOnce(new Response('{}',{headers:{'content-type':'application/json'}}));
    vi.stubGlobal('fetch',fetcher);
    await api.login({code:'ABCDEFGH',name:'Web · Mac'});
    await api.logout();
    const [path,init]=fetcher.mock.calls[0]!;
    expect(path).toBe('/api/auth/login');
    expect(JSON.parse(init.body)).toEqual({code:'ABCDEFGH',name:'Web · Mac'});
    expect(init.credentials).toBe('same-origin');
    expect(init.headers.has('Authorization')).toBe(false);
    expect(fetcher.mock.calls[1]![1].headers.get('X-CSRF-Token')).toBe('paired-csrf');
  });
  it('keeps legacy token callers compatible without a bearer header',async()=>{
    const fetcher=vi.fn().mockResolvedValue(new Response(JSON.stringify({authenticated:true,tokenRequired:true,csrfToken:'legacy-csrf'}),{headers:{'content-type':'application/json'}}));
    vi.stubGlobal('fetch',fetcher);
    await api.login('legacy-token');
    expect(JSON.parse(fetcher.mock.calls[0]![1].body)).toEqual({token:'legacy-token'});
    expect(fetcher.mock.calls[0]![1].headers.has('Authorization')).toBe(false);
  });
});
