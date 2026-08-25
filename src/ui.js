export function renderHome(config, message = '') {
  const nativeMode = config.gatewayMode === 'native';
  const endpoints = nativeMode ? config.solanaRpcUrls : config.upstreamGateways;
  const endpointItems = endpoints.map((host) => `<li><code>${escapeHtml(host)}</code></li>`).join('');
  const safeMessage = message ? `<div class="notice notice-error" role="alert">${escapeHtml(message)}</div>` : '';
  const modeLabel = nativeMode ? 'Native mode' : 'Proxy mode';
  const modeDescription = nativeMode
    ? '名称由 Solana RPC 解析，文件优先从普通 Arweave 节点读取。'
    : '通过配置的公共 Gateway 获取内容，并使用短期代理缓存。';

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="description" content="在本机解析 ArNS 名称并打开 Arweave 永久网站。">
  <meta name="color-scheme" content="dark light">
  <title>ArNS Local Gateway</title>
  <style>
    :root{color-scheme:dark;--bg:#07110e;--surface:rgba(15,31,26,.82);--line:rgba(148,210,185,.19);--line-strong:rgba(110,240,180,.42);--text:#edfff7;--muted:#9ab9ad;--accent:#66f2ae;--accent-strong:#37d68a;--accent-ink:#042116;--danger:#ffb4b4;--shadow:0 30px 90px rgba(0,0,0,.38)}
    *{box-sizing:border-box}html{min-width:320px;background:var(--bg)}body{margin:0;min-height:100vh;color:var(--text);background:radial-gradient(circle at 12% -8%,rgba(62,218,145,.19),transparent 34rem),radial-gradient(circle at 92% 14%,rgba(68,133,255,.10),transparent 28rem),linear-gradient(180deg,#091612 0%,var(--bg) 72%);font:16px/1.55 Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    body::before{content:"";position:fixed;inset:0;pointer-events:none;opacity:.22;background-image:linear-gradient(var(--line) 1px,transparent 1px),linear-gradient(90deg,var(--line) 1px,transparent 1px);background-size:64px 64px;mask-image:linear-gradient(to bottom,#000,transparent 75%)}
    a{color:inherit}button,input{font:inherit}.shell{position:relative;width:min(1120px,calc(100% - 40px));margin:0 auto}.topbar{display:flex;align-items:center;justify-content:space-between;gap:24px;padding:28px 0 18px}.brand{display:inline-flex;align-items:center;gap:12px;font-weight:760;letter-spacing:-.02em}.mark{width:34px;height:34px;display:grid;place-items:center;border:1px solid var(--line-strong);border-radius:11px;background:rgba(102,242,174,.09);color:var(--accent);font:800 15px/1 ui-monospace,SFMono-Regular,Consolas,monospace;box-shadow:inset 0 0 18px rgba(102,242,174,.08)}
    .status{display:inline-flex;align-items:center;gap:9px;min-height:34px;padding:7px 12px;border:1px solid var(--line);border-radius:999px;color:var(--muted);background:rgba(7,17,14,.6);font-size:13px}.status-dot{width:8px;height:8px;border-radius:50%;background:var(--accent);box-shadow:0 0 14px rgba(102,242,174,.8)}main{padding:60px 0 48px}.hero{display:grid;grid-template-columns:minmax(0,1.35fr) minmax(280px,.65fr);gap:28px;align-items:stretch}.panel{border:1px solid var(--line);border-radius:26px;background:var(--surface);box-shadow:var(--shadow);backdrop-filter:blur(18px)}
    .primary{padding:clamp(30px,6vw,66px);overflow:hidden;position:relative}.primary::after{content:"ar://";position:absolute;right:-20px;bottom:-42px;color:rgba(102,242,174,.035);font:900 clamp(110px,20vw,230px)/1 ui-monospace,SFMono-Regular,Consolas,monospace;letter-spacing:-.12em;pointer-events:none}.eyebrow{margin:0 0 18px;color:var(--accent);font:700 12px/1.2 ui-monospace,SFMono-Regular,Consolas,monospace;letter-spacing:.15em;text-transform:uppercase}h1{max-width:760px;margin:0;font-size:clamp(38px,7vw,72px);line-height:.98;letter-spacing:-.055em}.lede{max-width:650px;margin:24px 0 0;color:var(--muted);font-size:clamp(16px,2vw,19px)}
    .gateway-form{position:relative;z-index:1;display:grid;grid-template-columns:1fr auto;gap:10px;margin-top:38px;padding:8px;border:1px solid var(--line);border-radius:16px;background:rgba(4,14,11,.82);transition:border-color .18s,box-shadow .18s}.gateway-form:focus-within{border-color:var(--line-strong);box-shadow:0 0 0 4px rgba(102,242,174,.08)}.gateway-form input{min-width:0;width:100%;padding:13px 14px;border:0;outline:0;color:var(--text);background:transparent}.gateway-form input::placeholder{color:#66887b}.gateway-form button{border:0;border-radius:11px;padding:13px 20px;color:var(--accent-ink);background:linear-gradient(135deg,var(--accent),var(--accent-strong));font-weight:780;cursor:pointer;box-shadow:0 9px 28px rgba(55,214,138,.19);transition:transform .18s,filter .18s}.gateway-form button:hover{transform:translateY(-1px);filter:brightness(1.05)}.gateway-form button:active{transform:translateY(0)}
    .quick{position:relative;z-index:1;display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:14px;color:var(--muted);font-size:13px}.quick button{border:1px solid var(--line);border-radius:999px;padding:6px 10px;color:#cbe8dc;background:rgba(14,34,27,.72);cursor:pointer}.quick button:hover,.quick button:focus-visible{border-color:var(--line-strong);color:var(--accent);outline:none}.notice{position:relative;z-index:1;margin-top:24px;border-radius:12px;padding:12px 14px;font-size:14px}.notice-error{border:1px solid rgba(255,143,143,.32);color:var(--danger);background:rgba(105,23,23,.22)}
    .side{display:grid;gap:14px;padding:18px}.metric,.privacy{padding:20px;border:1px solid var(--line);border-radius:18px;background:rgba(8,22,17,.62)}.metric-label{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.1em}.metric-value{margin-top:8px;font-size:20px;font-weight:760;letter-spacing:-.025em}.metric-copy,.privacy p{margin:8px 0 0;color:var(--muted);font-size:13px}.privacy{margin-top:auto;background:rgba(102,242,174,.055)}.privacy strong{color:var(--accent)}
    .workflow{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-top:28px}.step{min-height:150px;padding:22px;border:1px solid var(--line);border-radius:20px;background:rgba(13,29,24,.7)}.step-number{color:var(--accent);font:700 12px/1 ui-monospace,SFMono-Regular,Consolas,monospace}.step h2{margin:18px 0 8px;font-size:17px}.step p{margin:0;color:var(--muted);font-size:14px}details{margin-top:18px;border:1px solid var(--line);border-radius:16px;background:rgba(9,22,17,.58)}summary{padding:16px 18px;cursor:pointer;color:#cce6dc;font-weight:650}.details-body{padding:0 18px 18px;color:var(--muted);font-size:13px}.details-body ul{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px 18px;margin:10px 0;padding-left:20px}code{color:#c9ffe5;font:.92em/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;overflow-wrap:anywhere}footer{display:flex;justify-content:space-between;gap:20px;padding:28px 0 38px;color:#6f9184;font-size:12px}:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
    @media(max-width:820px){.hero{grid-template-columns:1fr}.side{grid-template-columns:repeat(2,1fr)}.privacy{margin-top:0;grid-column:1/-1}.workflow{grid-template-columns:1fr}}
    @media(max-width:560px){.shell{width:min(100% - 24px,1120px)}.topbar{align-items:flex-start}.brand span:last-child{display:none}main{padding-top:32px}.primary{padding:28px 22px;border-radius:22px}.gateway-form{grid-template-columns:1fr}.gateway-form button{width:100%}.side{grid-template-columns:1fr}.privacy{grid-column:auto}.details-body ul{grid-template-columns:1fr}footer{flex-direction:column}}
    @media(prefers-reduced-motion:reduce){*,*::before,*::after{scroll-behavior:auto!important;transition:none!important}}
  </style>
</head>
<body>
  <div class="shell">
    <header class="topbar">
      <div class="brand"><span class="mark" aria-hidden="true">AR</span><span>ArNS Local Gateway</span></div>
      <div class="status" aria-live="polite"><span class="status-dot" aria-hidden="true"></span><span id="runtime-status">本地服务已连接</span></div>
    </header>
    <main>
      <section class="hero" aria-labelledby="hero-title">
        <div class="panel primary">
          <p class="eyebrow">Local-first permaweb access</p>
          <h1 id="hero-title">输入 ArNS，<br>在本机打开永久网站。</h1>
          <p class="lede">解析名称、路由 Manifest，并从普通 Arweave 节点提取所需文件。已下载内容进入本地不可变对象库。</p>
          ${safeMessage}
          <form class="gateway-form" action="/open" method="get">
            <label for="arns-input" hidden>ArNS 名称或地址</label>
            <input id="arns-input" name="name" placeholder="例如 permapages、docs.ar.io 或 ar://sam" autocomplete="off" spellcheck="false" autofocus required>
            <button type="submit">打开网站&nbsp; →</button>
          </form>
          <div class="quick" aria-label="示例地址">
            <span>快速尝试</span>
            <button type="button" data-example="sam.arweave.dev">sam</button>
            <button type="button" data-example="permapages">permapages</button>
            <button type="button" data-example="docs.ar.io">docs</button>
          </div>
        </div>
        <aside class="panel side" aria-label="运行状态">
          <div class="metric"><div class="metric-label">Access mode</div><div class="metric-value">${escapeHtml(modeLabel)}</div><p class="metric-copy">${escapeHtml(modeDescription)}</p></div>
          <div class="metric"><div class="metric-label">Peer network</div><div class="metric-value" id="peer-count">${nativeMode ? '正在读取节点池' : `${endpoints.length} gateways`}</div><p class="metric-copy">失败时自动切换节点，并从已知 peer 继续发现。</p></div>
          <div class="privacy"><strong>本地优先</strong><p>名称与缓存留在当前设备。首次获取新内容时才访问配置的 RPC、索引和 Arweave 节点。</p></div>
        </aside>
      </section>
      <section class="workflow" aria-label="工作流程">
        <article class="step"><span class="step-number">01 / RESOLVE</span><h2>解析 ArNS</h2><p>从 Solana RPC 读取名称记录与 TTL，得到当前 Target ID。</p></article>
        <article class="step"><span class="step-number">02 / RETRIEVE</span><h2>按需获取文件</h2><p>解析 Manifest；offset 与 Chunk 可由不同普通 Arweave 节点提供。</p></article>
        <article class="step"><span class="step-number">03 / PRESERVE</span><h2>永久本地缓存</h2><p>Data ID 内容不可变，成功下载后无需按时间失效。</p></article>
      </section>
      <details>
        <summary>${nativeMode ? '网络端点与实现说明' : '当前上游与缓存说明'}</summary>
        <div class="details-body"><ul>${endpointItems}</ul><p>${nativeMode
          ? 'GraphQL 仅用于定位父 Bundle；网站文件优先通过普通 Arweave 节点的 offset/Chunk 接口获取。raw Gateway 只作为最终兼容兜底。'
          : `新鲜代理缓存最多 ${config.cacheTtlSeconds} 秒；上游失败时可以使用可读的过期缓存。`}</p></div>
      </details>
    </main>
    <footer><span>ArNS Local Gateway · read-only local access</span><span>默认监听 127.0.0.1，不向局域网公开。</span></footer>
  </div>
  <script>
    const input = document.getElementById('arns-input');
    document.querySelectorAll('[data-example]').forEach((button) => {
      button.addEventListener('click', () => { input.value = button.dataset.example; input.focus(); });
    });
    fetch('/api/status', { headers: { accept: 'application/json' } })
      .then((response) => response.ok ? response.json() : Promise.reject(new Error('status unavailable')))
      .then((status) => {
        const peerCount = status.peerDiscovery?.currentPoolSize;
        if (Number.isFinite(peerCount)) document.getElementById('peer-count').textContent = peerCount + ' peers';
        document.getElementById('runtime-status').textContent = status.mode === 'native' ? '原生模式运行中' : '代理模式运行中';
      })
      .catch(() => { document.getElementById('runtime-status').textContent = '本地服务状态未知'; });
  </script>
</body>
</html>`;
}

export function renderGatewayError(name, errors, hasStale = false) {
  const detail = errors.map((item) => `<li><code>${escapeHtml(item.gateway)}</code>: ${escapeHtml(item.error)}</li>`).join('');
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>无法打开 · ArNS Local Gateway</title>
  <style>body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:#07110e;color:#edfff7;font:16px/1.6 system-ui}.card{width:min(720px,100%);padding:32px;border:1px solid #29483d;border-radius:18px;background:#10221c}code,a{color:#66f2ae}.muted{color:#9ab9ad}</style>
  <main class="card"><p class="muted">ArNS Local Gateway</p><h1>无法打开 ${escapeHtml(name)}</h1>
  <p>所有配置的上游都没有返回可用内容${hasStale ? '，本地缓存也不可读' : ''}。</p>
  <ul>${detail}</ul><p><a href="http://localhost:4318/">返回入口</a></p></main></html>`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}
