# 缓存与 RPC 池

此说明适用于默认 `native` 模式。旧 `proxy` 模式仍是整站 Gateway 代理，不使用这里的 Solana 池和浏览器桥接。

## 缓存分层

| 内容 | 策略 | 原因 |
|---|---|---|
| ArNS 名称 → Target | 按 ANT 记录的 TTL 刷新 | 名称可以指向新版本 |
| Data ID → 文件 | `.data/objects` 永久保存 | 同一个 ID 的内容不可变 |
| 浏览器的 `<name>.localhost/path` | `no-cache, must-revalidate`，支持 ETag/304 | 同一路径可能因 Target 更新而改变 |
| Solana 只读查询结果 | 内存中缓存 2 秒，可配置为 0 | 账户、投票和列表可以更新 |

`no-cache` 并非不保存文件，而是浏览器再次使用时先向本地服务确认。服务先解析名称，再检查 ETag；ETag 同时包含当前 Target 和实际响应字节，因此新 Target 不会被旧的 304 冻结。确认文件未变时无需重新传输正文，本地对象也不必重新下载。

TTL 到期而 RPC 全部不可用时，允许继续使用旧的 ArNS 解析记录，响应标为 `resolution-cache-stale`、`no-store`，并携带 stale Warning。后续 30 秒内避免重复刷新同一个失败名称；强制刷新可以跳过此退避。过期不等于删除缓存。

强制刷新名称：

```text
http://localhost:4318/api/resolve?name=cyberleek&refresh=1
```

它也跳过 2 秒 RPC 结果缓存，但仍会合并相同的在途请求，并遵守节点冷却。

升级后请对之前访问过的网站按一次 `Ctrl+Shift+R`。旧版本已发给浏览器的长效 `immutable` 缓存无法被服务端追溯撤销。不要为此删除 `.data/objects`。

## 两种池子的分工

- Arweave peer 池：通过 `/peers` BFS 发现节点，通过 `/tx/<id>/offset` 和 `/chunk/<offset>` 获取文件字节。快照为 `.data/peer-pool.json`。
- Solana RPC 池：读取链上账户，供 ArNS/ANT 解析和接入桥接的网页业务查询使用。快照为 `.data/solana-rpc-pool.json`。

视频文件不会从 Solana RPC 返回；Solana 中保存的视频标题、链接等账户数据则可以由该 RPC 池读取。

## RPC 选择和失败切换

`SOLANA_RPC_URLS` 是候选 seed 列表，不保证任何公共服务永久可用。各方法独立记录成功和失败，优先选择曾成功执行该方法的节点，而不是仅检查 `getSlot` 或 `getHealth`。

- HTTP 401/403、方法不支持：该方法冷却 15 分钟；同节点其他读取方法仍可使用。
- HTTP 429 / 限流：整个节点冷却 30～120 秒，考虑数值形式的 `Retry-After`。
- 网络错误或其他服务错误：该方法按 5～60 秒指数退避。
- 明确的无效参数：直接返回参数错误，不对每个节点重复发送。
- 单节点默认超时 4 秒，单次 RPC 池查询总预算 18 秒。ArNS 解析包含多次查询，不代表整个名称解析也只需 18 秒。
- 相同方法和参数的并发请求合并；失败结果不缓存。JSON 编解码保留 Solana 64 位整数精度。
- 短缓存最多 128 条、序列化正文合计 32 MiB；新请求会清理已过期条目，不会将动态状态写入永久文件库。

## 有边界的节点发现

候选耗尽后，或每 6 小时定期刷新时，从 seed 和历史快照出发请求 `getClusterNodes`，只读取返回对象的 `rpc` 字段，再对发现的节点继续 BFS。

默认限制为深度 2、最多探测 48 个节点、池中最多 32 个端点、探测并发 3。失败触发的完整发现最多每分钟启动一次；新节点一旦通过网络检查，等待中的查询即可尝试它，其他发现继续在后台进行。

自动发现只接受字面量公网 IPv4 加端口，过滤私网、回环、链路本地和保留地址，不遍历端口，也不把 `gossip`、TPU 地址当作 RPC。显式配置的 seed 可以是用户自己的私有服务。

通过 `getGenesisHash` 与 seed 确定的网络比较，避免混入其他 Solana 网络。网络标识和发现地址会保存；重启后地址只是提示，必须重新检查才用于查询。已有网络标识使 seed 暂时离线时仍能从旧地址恢复发现。发现节点连续两轮探测失败且本轮仍有其他可达节点时会被移除；整轮断网不清空快照。

这些检查不是共识或密码学真实性证明。节点可以拒绝服务或返回错误数据；当前实现不比较多个 RPC 的账户值。许多验证者的 `rpc` 为 null 或不向公众开放，因此 BFS 不能保证遍历所有节点，更不能保证发现可用的历史索引服务。

## 网页只读 RPC 桥接

只更换 ArNS 解析 RPC 无法修复网页自己写死的 RPC 地址。为此增加了可选桥接：

```text
网页 window.fetch → 同源 /_local/solana-rpc → Solana RPC 池 → 账户结果
```

默认只对 `cyberleek` 注入 `/_local/solana-rpc-bridge.js`，在应用脚本运行前接管配置名单中的 Solana RPC 主机。磁盘中保存的原始 HTML 不修改；仅本地 HTTP 响应插入桥接脚本。

桥接只处理已支持的只读 JSON-RPC 请求；不转发交易签名/发送，不接管钱包或任意 API，不自动改写其他链的 RPC。尚不覆盖 Web Worker、WebSocket、XMLHttpRequest 和浏览器侧 JSON-RPC 批量请求。严格 CSP 也可能阻止注入的脚本执行。其他网站需确认请求方式及目标网络后再加入名称与主机名单。

本地接口只接受 POST，检查浏览器 Origin，限制请求为 64 KiB、批量为 1～20 项、上游响应为 16 MiB；HTTP 响应 `no-store`。它没有公网服务的认证和配额，仍应只监听回环地址。

## 配置与诊断

所有配置只作用于启动进程，不修改系统环境。项目不会自动读取 `.env`，完整变量见 `.env.example`。

```powershell
# 当前终端内设置；空字符串关闭网页注入，ArNS 解析仍用 RPC 池
$env:SOLANA_RPC_BRIDGE_NAMES = ''
$env:SOLANA_RPC_DISCOVERY_ENABLED = 'false'
$env:SOLANA_RPC_CACHE_TTL_MS = '0'
npm start
```

需要启用其他站点时可设置 `SOLANA_RPC_BRIDGE_NAMES=cyberleek,example`，并把其 Solana 主机加入 `SOLANA_RPC_BROWSER_HOSTS`。`*` 明确表示所有名称，默认不启用。

`/api/status` 包含池大小、发现状态和每个方法的成功/失败/冷却时间。不会显示 RPC URL 中的 API key 路径或查询参数。

`npm run check:endpoints` 分别探测 `getSlot`、`getAccountInfo` 和小结果的 `getProgramAccounts`，而不只检查基本健康；某种查询的成功不保证所有程序、过滤器、历史数据或返回大小都受支持。

`npm test` 包含节点切换、限流冷却、并发合并、短缓存、BFS/网络过滤、名称 TTL、HTTP 304 和只读桥接的离线回归测试。
