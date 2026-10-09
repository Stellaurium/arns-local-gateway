import { READ_METHODS } from './solana-rpc-pool.js';

export const RPC_PATH = '/_local/solana-rpc';
export const BRIDGE_PATH = '/_local/solana-rpc-bridge.js';
export function bridgeEnabled(name,names=[]) { return names.includes(name)||names.includes('*'); }

export function bridgeScript(config) {
  const hosts=[...new Set([...config.solanaRpcUrls.map(url=>new URL(url).hostname),...config.solanaRpcBrowserHosts])];
  return `(() => {
    const originalFetch=window.fetch.bind(window);
    const hosts=new Set(${JSON.stringify(hosts)});
    const methods=new Set(${JSON.stringify([...READ_METHODS])});
    window.fetch=async function(input,init) {
      const request=input instanceof Request?input:null;
      let raw,payload;
      try {
        const url=new URL(request?request.url:String(input),location.href);
        const method=String(init?.method||request?.method||'GET').toUpperCase();
        if(method!=='POST'||!hosts.has(url.hostname))return originalFetch(input,init);
        raw=init?.body??(request?await request.clone().text():null);
        if(typeof raw!=='string')return originalFetch(input,init);
        payload=JSON.parse(raw);
        if(payload?.jsonrpc!=='2.0'||!methods.has(payload.method))return originalFetch(input,init);
      } catch { return originalFetch(input,init); }
      return originalFetch(${JSON.stringify(RPC_PATH)},{method:'POST',headers:{'content-type':'application/json'},
        body:raw,signal:init?.signal||request?.signal,cache:'no-store',credentials:'omit'});
    };
  })();`;
}

export function injectBridge(body) {
  const html=body.toString('utf8'),script=`<script src="${BRIDGE_PATH}"></script>`;
  return Buffer.from(/<head\b[^>]*>/i.test(html)?html.replace(/<head\b[^>]*>/i,head=>head+script):script+html);
}
