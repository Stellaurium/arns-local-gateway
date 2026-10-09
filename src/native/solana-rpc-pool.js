import fs from 'node:fs/promises';
import path from 'node:path';
import { isIP } from 'node:net';
import { parseJsonWithBigInts, stringifyJsonWithBigInts } from '@solana/rpc-spec-types';

export const READ_METHODS = new Set([
  'getAccountInfo', 'getMultipleAccounts', 'getProgramAccounts', 'getBalance',
  'getTokenAccountBalance', 'getTokenAccountsByOwner', 'getTokenSupply',
  'getSlot', 'getBlockHeight', 'getLatestBlockhash', 'getBlock', 'getBlockTime',
  'getTransaction', 'getSignaturesForAddress', 'getSignatureStatuses',
  'getEpochInfo', 'getVersion', 'getHealth', 'getGenesisHash', 'getClusterNodes',
  'getMinimumBalanceForRentExemption', 'getSupply', 'getFeeForMessage'
]);

// Only literal public addresses advertised as RPCs are discovered, never gossip/TPU ports.
export function discoveredRpcUrl(address) {
  if (typeof address !== 'string') return null;
  const m = address.match(/^(\d+\.\d+\.\d+\.\d+):(\d+)$/);
  if (!m || isIP(m[1]) !== 4 || +m[2] < 1 || +m[2] > 65535) return null;
  const [a,b,c] = m[1].split('.').map(Number);
  if (a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 192 && b === 0 && (c === 0 || c === 2)) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)) return null;
  return `http://${m[1]}:${Number(m[2])}/`;
}

function seedUrl(value) {
  const u = new URL(value);
  if (!['http:','https:'].includes(u.protocol) || u.username || u.password || u.hash) throw new Error('Invalid Solana RPC URL');
  return u.href;
}

export class SolanaRpcPool {
  constructor({urls, directory, timeoutMs=4000, requestTimeoutMs=18000, cacheTtlMs=2000,
    discoveryEnabled=true, maxEndpoints=32, discoveryMaxDepth=2, discoveryMaxProbes=48,
    refreshIntervalMs=21600000, fetchImpl=fetch, now=Date.now, logger=console}) {
    this.seeds = [...new Set(urls.map(seedUrl))];
    this.records = new Map(this.seeds.map(url => [url,{url,seed:true,methods:new Map(),cooldownUntil:0}]));
    this.file = directory ? path.join(directory,'solana-rpc-pool.json') : null;
    Object.assign(this,{timeoutMs,requestTimeoutMs,cacheTtlMs,discoveryEnabled,maxEndpoints,
      discoveryMaxDepth,discoveryMaxProbes,refreshIntervalMs,fetchImpl,now,logger});
    this.cache = new Map(); this.pending = new Map();
    this.cacheBytes = 0; this.maxCacheBytes = 32 * 1024 * 1024;
    this.loadPromise = null; this.discoveryPromise = null; this.lastDiscoveryAt = 0;
    this.lastEndpoint = null; this.expectedGenesis = null; this.timer = null;
    this.shutdown = new AbortController();
    this.lastDiscoveryStats = null;
  }

  async load() {
    if (!this.loadPromise) this.loadPromise = (async () => {
      if (!this.file) return;
      try {
        const data = JSON.parse(await fs.readFile(this.file,'utf8'));
        if (typeof data.genesisHash === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(data.genesisHash))
          this.expectedGenesis = data.genesisHash;
        // Snapshots are hints: every discovered candidate is rechecked before use.
        for (const address of data.addresses ?? []) {
          const url = discoveredRpcUrl(address);
          if (url && !this.records.has(url) && this.records.size < this.maxEndpoints)
            this.records.set(url,{url,seed:false,verified:false,methods:new Map(),cooldownUntil:0});
        }
      } catch(e) { if(e.code !== 'ENOENT') this.logger.warn('Solana RPC snapshot could not be loaded'); }
    })();
    return this.loadPromise;
  }

  candidates(method) {
    const score = r => (r.methods.get(method)?.successes ? 100 : 0) + (r.seed ? 20 : 0) - (r.methods.get(method)?.failures ?? 0)*5;
    return [...this.records.values()].filter(r => (r.seed || r.verified) &&
      r.cooldownUntil <= this.now() && (r.methods.get(method)?.retryAt ?? 0) <= this.now())
      .sort((a,b) => score(b)-score(a));
  }

  async fetchRpc(url,method,params,signal) {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const response = await this.fetchImpl(url,{method:'POST',headers:{'content-type':'application/json'},
      body:stringifyJsonWithBigInts({jsonrpc:'2.0',id:1,method,params}),
      signal:AbortSignal.any([this.shutdown.signal, timeout, ...(signal ? [signal] : [])]),redirect:'error'});
    if (Number(response.headers.get('content-length') ?? 0) > 16*1024*1024) throw new Error('RPC response too large');
    const chunks = []; let length = 0;
    for await (const chunk of response.body) {
      length += chunk.length;
      if(length > 16*1024*1024) throw new Error('RPC response too large');
      chunks.push(chunk);
    }
    let data;
    try { data = parseJsonWithBigInts(Buffer.concat(chunks).toString('utf8')); } catch { data = null; }
    if (!response.ok || data?.error || !data || data.jsonrpc !== '2.0' || !Object.hasOwn(data,'result')) {
      const error = new Error(data?.error?.message ?? `RPC HTTP ${response.status}`);
      Object.assign(error,{status:response.status,rpcCode:Number(data?.error?.code),retryAfter:response.headers.get('retry-after')});
      error.restricted = /token|api.?key|index|disabled|unsupported|not available|not supported|paid|forbidden|unauthor/i.test(error.message);
      error.rateLimited = response.status === 429 || /rate.?limit|too many requests|quota|credits|request.?limit|per second|per minute/i.test(error.message);
      error.permanent = response.ok && [-32700,-32600,-32602].includes(error.rpcCode) && !error.restricted && !error.rateLimited;
      throw error;
    }
    return data.result;
  }

  async attempt(record,method,params,signal) {
    const s = record.methods.get(method) ?? {successes:0,failures:0,retryAt:0};
    record.methods.set(method,s);
    try {
      const result = await this.fetchRpc(record.url,method,params,signal);
      s.successes++; s.failures=0; s.retryAt=0; s.lastStatus=200; this.lastEndpoint=record.url;
      return result;
    } catch(e) {
      if(signal?.aborted || e.permanent) throw e;
      s.failures++; s.lastStatus=e.status ?? null;
      if(e.rateLimited) {
        const retry=Number(e.retryAfter);
        record.cooldownUntil=this.now()+Math.min(120000,Math.max(30000,Number.isFinite(retry)?retry*1000:0));
      } else s.retryAt=this.now()+([401,403].includes(e.status)||e.rpcCode===-32601||e.restricted?900000:Math.min(60000,5000*2**(s.failures-1)));
      this.logger.warn(`Solana RPC ${method}: ${e.status ?? 'timeout/network'}; trying another endpoint`);
      throw e;
    }
  }

  async call(method,params=[],{force=false}={}) {
    if(!READ_METHODS.has(method)) throw new Error('Only supported read-only Solana RPC methods are allowed');
    await this.load();
    for(const [key,entry] of this.cache) if(entry.expires<=this.now()) this.removeCached(key);
    const key=stringifyJsonWithBigInts([method,params]),cached=this.cache.get(key);
    if(!force && cached?.expires>this.now()) return cached.result;
    if(this.pending.has(key)) return this.pending.get(key);
    const pending=this.runCall(method,params).then(result => {
      if(this.cacheTtlMs>0) {
        const bytes=Buffer.byteLength(stringifyJsonWithBigInts(result));
        this.removeCached(key);
        while(this.cache.size && (this.cache.size>=128 || this.cacheBytes+bytes>this.maxCacheBytes))
          this.removeCached(this.cache.keys().next().value);
        if(bytes<=this.maxCacheBytes) {
          this.cache.set(key,{result,expires:this.now()+this.cacheTtlMs,bytes}); this.cacheBytes+=bytes;
        }
      }
      return result;
    }).finally(()=>this.pending.delete(key));
    this.pending.set(key,pending); return pending;
  }

  removeCached(key) {
    const entry=this.cache.get(key);
    if(entry) { this.cacheBytes-=entry.bytes; this.cache.delete(key); }
  }

  async runCall(method,params) {
    const deadline=AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(this.requestTimeoutMs)]),attempted=new Set();
    const tryCandidates=async()=>{
      for(const r of this.candidates(method)) {
        if(attempted.has(r.url)) continue;
        if(deadline.aborted) break;
        attempted.add(r.url);
        try{return {ok:true,result:await this.attempt(r,method,params,deadline)}}
        catch(e){if(e.permanent) throw e}
      }
      return {ok:false};
    };
    let result=await tryCandidates();
    if(result.ok) return result.result;
    if(this.discoveryEnabled && method!=='getClusterNodes' && !this.shutdown.signal.aborted) {
      let complete=false;
      void this.discover().then(()=>{complete=true},()=>{complete=true});
      // Exhausted requests return promptly; discovery can still recover the next request.
      if(deadline.aborted) throw new Error(`No available Solana RPC for ${method}; endpoints are unavailable or cooling down`);
      // Use newly verified nodes immediately; do not wait for unrelated dead BFS branches.
      do {
        result=await tryCandidates(); if(result.ok) return result.result;
        if(complete || deadline.aborted) break;
        await new Promise(resolve=>{
          let timer;
          const finish=()=>{clearTimeout(timer);deadline.removeEventListener('abort',finish);resolve()};
          timer=setTimeout(finish,100);
          deadline.addEventListener('abort',finish,{once:true});
          if(deadline.aborted) finish();
        });
      } while(!deadline.aborted);
    }
    throw new Error(`No available Solana RPC for ${method}; endpoints are unavailable or cooling down`);
  }

  async discover({force=false}={}) {
    if(!this.discoveryEnabled || this.shutdown.signal.aborted) return [];
    await this.load();
    if(this.discoveryPromise) return this.discoveryPromise;
    if(!force && this.lastDiscoveryAt && this.now()-this.lastDiscoveryAt<60000) return [];
    this.lastDiscoveryAt=this.now();
    this.discoveryPromise=this.runDiscovery().finally(()=>{this.discoveryPromise=null});
    return this.discoveryPromise;
  }

  async runDiscovery() {
    if(!this.expectedGenesis) for(const url of this.seeds) {
      try{this.expectedGenesis=await this.fetchRpc(url,'getGenesisHash',[]);break}catch{}
    }
    if(!this.expectedGenesis) {
      this.lastDiscoveryStats={probed:0,reachable:0,advertised:0,added:0,reason:'seed-network-check-failed'};
      return [];
    }
    const queue=[...this.records.values()].map(r=>({url:r.url,depth:0})),visited=new Set(),added=[],failed=new Set(),advertised=new Set();
    let reached=0;
    while(queue.length && visited.size<this.discoveryMaxProbes && !this.shutdown.signal.aborted) {
      const batch=[];
      while(queue.length && batch.length<3 && visited.size<this.discoveryMaxProbes) {
        const next=queue.shift();if(visited.has(next.url))continue;visited.add(next.url);batch.push(next);
      }
      await Promise.all(batch.map(async({url,depth})=>{
        try {
          if(await this.fetchRpc(url,'getGenesisHash',[])!==this.expectedGenesis) {
            const stale=this.records.get(url); if(stale && !stale.seed) this.records.delete(url);
            return;
          }
          reached++;
          let r=this.records.get(url);
          if(!r){
            if(this.records.size>=this.maxEndpoints) {
              const stale=[...failed].find(candidate=>!this.records.get(candidate)?.seed);
              if(stale) this.records.delete(stale); else return;
            }
            r={url,seed:false,verified:true,methods:new Map(),cooldownUntil:0};this.records.set(url,r);added.push(url);
          }
          r.verified=true;
          r.discoveryFailures=0;
          if(depth>=this.discoveryMaxDepth)return;
          const peers=await this.fetchRpc(url,'getClusterNodes',[]);if(!Array.isArray(peers))return;
          for(const node of peers){
            const candidate=discoveredRpcUrl(node.rpc);
            if(candidate) advertised.add(candidate);
            if(candidate&&!visited.has(candidate)&&queue.length<this.discoveryMaxProbes*2)queue.push({url:candidate,depth:depth+1});
          }
        }catch{
          const stale=this.records.get(url);
          if(stale && !stale.seed && !this.shutdown.signal.aborted) {
            stale.discoveryFailures=(stale.discoveryFailures ?? 0)+1;
            failed.add(url);
          }
        }
      }));
    }
    // Preserve the last snapshot during a complete network outage.
    if(reached) for(const url of failed) {
      if((this.records.get(url)?.discoveryFailures ?? 0)>=2) this.records.delete(url);
    }
    this.lastDiscoveryStats={probed:visited.size,reachable:reached,advertised:advertised.size,added:added.length};
    if(this.file && reached && !this.shutdown.signal.aborted){
      await fs.mkdir(path.dirname(this.file),{recursive:true});
      const addresses=[...this.records.values()].filter(r=>!r.seed&&r.verified).map(r=>new URL(r.url).host);
      const temporary=`${this.file}.${process.pid}.tmp`;
      await fs.writeFile(temporary,JSON.stringify({updatedAt:this.now(),genesisHash:this.expectedGenesis,addresses},null,2));await fs.rename(temporary,this.file);
    }
    return added;
  }

  status() {
    return {size:this.records.size,discoveryEnabled:this.discoveryEnabled,discovering:!!this.discoveryPromise,lastDiscoveryAt:this.lastDiscoveryAt,
      lastDiscovery:this.lastDiscoveryStats,cacheEntries:this.cache.size,cacheBytes:this.cacheBytes,
      endpoints:[...this.records.values()].map(r=>({host:new URL(r.url).host,seed:r.seed,verified:!!r.verified,coolingDown:r.cooldownUntil>this.now(),
        methods:Object.fromEntries([...r.methods].map(([method,s])=>[method,{successes:s.successes,failures:s.failures,retryAt:s.retryAt,lastStatus:s.lastStatus}]))}))};
  }

  start(){if(!this.discoveryEnabled||this.timer)return;this.timer=setInterval(()=>{void this.discover({force:true}).catch(()=>this.logger.warn('Solana RPC discovery failed'))},this.refreshIntervalMs);this.timer.unref?.()}
  stop(){clearInterval(this.timer);this.timer=null;this.shutdown.abort()}
}

export function createConfiguredSolanaRpcPool(config, logger = console) {
  return new SolanaRpcPool({
    urls: config.solanaRpcUrls, directory: config.dataDir,
    timeoutMs: config.solanaRpcTimeoutMs, requestTimeoutMs: config.solanaRpcRequestTimeoutMs,
    cacheTtlMs: config.solanaRpcCacheTtlMs, discoveryEnabled: config.solanaRpcDiscoveryEnabled,
    maxEndpoints: config.solanaRpcMaxEndpoints, discoveryMaxDepth: config.solanaRpcDiscoveryMaxDepth,
    discoveryMaxProbes: config.solanaRpcDiscoveryMaxProbes,
    refreshIntervalMs: config.solanaRpcRefreshIntervalMs, logger
  });
}
