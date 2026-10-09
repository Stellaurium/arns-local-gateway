# ArNS Local Gateway

在本机输入一个 ArNS 名称或地址，解析其当前 Target，并通过 `http://<name>.localhost:4318/` 打开对应的 Permaweb 网站。

```text
ArNS input → Solana RPC → Target ID → Manifest/Data ID
                                      ↓
                          Arweave peers /offset + /chunk
                                      ↓
                         local immutable object store
```

> 项目状态：**Alpha，可用但尚未完全 trustless。** 静态站、Manifest、多文件应用和普通 L1 数据已经可以访问；完整证明验证、嵌套 Bundle 和生产级公网部署仍在路线图中。

## 特性

- 接受 `permapages`、`permapages.ar`、`ar://permapages`、`docs.ar.io` 等输入形式。
- 直接从 Solana RPC 读取 ArNS/ANT 状态，不依靠公共 Gateway 的子域名解析。
- Solana RPC 池按查询方法自动切换、退避和有限 BFS 发现；可选桥接网页自身的只读 RPC。
- 自己解析 Arweave Path Manifest 和浏览器子路径。
- 从普通 Arweave 节点读取交易 offset 与 Chunk；offset 和 Chunk 可以来自不同节点。
- 从 seed 和历史快照执行 `/peers` BFS，维护本地节点池并定期增删更新。
- 支持 Bundle Data Item 和普通非 Bundle L1 数据。
- 根据链上 Content-Encoding 解码 gzip、deflate 和 Brotli 文件，保留原始不可变缓存。
- Data ID 内容永久缓存在本地，不设置人为过期时间。
- raw Gateway 仅作为可选的最后兼容兜底。
- 默认只监听 `127.0.0.1`，不包含遥测、账户或外部管理服务。

## 快速开始

要求 Node.js 20.18.0 或更新版本。

第一次安装、磁盘占用、更新和常见故障见 [安装与构建](doc/安装与构建.md)。

Windows PowerShell：

```powershell
git clone https://github.com/Stellaurium/arns-local-gateway.git
Set-Location -LiteralPath '.\arns-local-gateway'
.\install-local.ps1
.\start.ps1
```

Linux/macOS：

```bash
git clone https://github.com/Stellaurium/arns-local-gateway.git
cd arns-local-gateway
npm ci --cache ./.npm-cache --no-audit --no-fund
npm start
```

浏览器打开：

```text
http://localhost:4318/
```

输入 ArNS 地址，或者直接访问：

```text
http://permapages.localhost:4318/
http://docs.localhost:4318/
```

`*.localhost` 会被现代浏览器解析到本机回环地址，并为每个 ArNS 名称提供独立的 Web Origin。

## 输入格式

以下输入都会被规范化为 ArNS 名称：

```text
permapages
permapages.ar
ar://permapages
sam.arweave.dev
https://docs.ar.io/learn
```

支持 undername，例如 `app_example`。

## 获取流程

1. 从多个 Solana RPC 中读取 ArNS Registry 与 ANT 记录，得到 Target ID 和 TTL。
2. 从本地 `.data/objects` 查找 Target；命中时直接返回。
3. 通过 GraphQL 查询 Data ID 是否位于父 Bundle。
4. 从 peer 池中的任一节点取得交易绝对 offset。
5. 每个 Chunk 独立跨节点重试；全部候选失败时沿 `/peers` 逐层发现新节点。
6. Bundle 数据只读取索引头和目标 Item 覆盖的 Chunk，不保存整个父 Bundle。
7. 验证并保存不可变对象；如果原生路径最终失败，再尝试可选 raw provider。
8. 如果 Target 是 Path Manifest，根据浏览器路径查找相应 Data ID。

## Peer 快照

`ARWEAVE_PEERS` 只作为 seed。程序会把 BFS 结果保存到：

```text
.data/peer-pool.json
```

默认每 6 小时从 seed 加旧快照重新遍历。刷新成功后会删除本轮既不可访问、也没有被活节点再次提到的旧地址；整轮网络不可用时保留原快照。长时间 BFS 会增量保存检查点，异常退出后可继续使用已经发现的节点。

## 缓存与磁盘

```text
.data/resolutions/   ArNS → Target 的 TTL 缓存
.data/objects/       Data ID → 不可变文件与元数据
.data/peer-pool.json 节点发现快照
.data/solana-rpc-pool.json Solana RPC 发现快照
node_modules/        项目本地依赖
.npm-cache/          项目本地 npm 下载缓存
```

ArNS 名称映射可变，必须遵守 TTL；Data ID 内容不可变，因此本地对象不会按时间失效。磁盘只随实际访问的文件增长，不会自动下载整个 Arweave 链或所有 Bundle。

名称 URL 使用 `no-cache, must-revalidate` 和 ETag/304，避免浏览器把旧网站版本永久冻结；动态 RPC 查询仅短缓存 2 秒。详细策略及升级后的强制刷新方式见 [缓存与 RPC 池](doc/缓存与RPC池.md)。

预下载一个 Manifest 网站：

```powershell
npm run mirror -- permapages
```

## 网络依赖

首次访问尚未缓存的网站仍需要：

- Solana JSON-RPC：解析 ArNS/ANT。
- Bundle GraphQL index：定位父 Bundle；它不提供网站文件正文。
- 普通 Arweave peer：提供 offset 和 Chunk。
- 可选 raw provider：原生路径完全失败后的兼容兜底。

强制禁止 raw Gateway 兜底：

```powershell
$env:DATA_PROVIDER_URLS = ''
npm start
```

已经完整缓存的网站可以在上述服务离线时继续打开；网页自身的 JavaScript 可能仍会连接钱包、AO、RPC、价格 API 或其他后端。

## 配置

项目不会自动修改系统环境，也不会写用户级 npm 配置。完整示例见 [`.env.example`](.env.example)。常用变量：

| 变量 | 默认含义 |
|---|---|
| `HOST` | `127.0.0.1`，只监听本机 |
| `PORT` | `4318` |
| `SOLANA_RPC_URLS` | ArNS/ANT 与已接入网页的 Solana 只读查询候选 |
| `SOLANA_RPC_BRIDGE_NAMES` | 注入只读 RPC 桥接的 ArNS 名称；默认 `cyberleek`，空值关闭 |
| `SOLANA_RPC_DISCOVERY_ENABLED` | 是否通过 `getClusterNodes` 有限 BFS 发现，默认开启 |
| `SOLANA_RPC_CACHE_TTL_MS` | 动态 RPC 查询短缓存，默认 2000；0 禁用 |
| `BUNDLE_INDEX_URLS` | `bundledIn` GraphQL 候选 |
| `ARWEAVE_PEERS` | BFS seed 节点 |
| `PEER_DISCOVERY_MAX_PEERS` | 节点快照上限，默认 512 |
| `PEER_DISCOVERY_MAX_DEPTH` | BFS 深度，默认 2 |
| `PEER_REFRESH_INTERVAL_SECONDS` | 完整刷新周期，默认 21600 |
| `DATA_PROVIDER_URLS` | 可选 raw 兜底；空字符串表示禁用 |
| `DATA_DIR` | 本地解析、对象和 peer 数据目录 |
| `MAX_RESPONSE_MB` | 单个对象最大值，默认 64 MiB |

## 测试

```powershell
npm test
npm run check:endpoints
```

- `npm test`：确定性单元/回归测试，不依赖公共网络。
- `check:endpoints`：检查当前 RPC、GraphQL 和 seed 节点。

空缓存、全新浏览器的实站验证及已知限制见 [兼容性测试](doc/兼容性测试.md)。

## 目前还不完整的部分

- 未验证完整 Data Item 公钥签名。
- 未把 Chunk 的 Merkle proof 锚定到独立验证的可信区块头。
- 父 Bundle 定位仍使用外部 GraphQL index。
- 暂不支持任意深度的嵌套 Bundle。
- 大文件目前整体进入内存后再响应，尚未实现端到端流式传输和 HTTP Range。
- 没有面向公网部署的 HTTPS、认证、配额和滥用防护。
- 已接入桥接的网页可经本地池读取 Solana 数据，但不能离线刷新链上状态；钱包、AO、其他 API 及未接入的请求仍依赖外部服务。

因此它适合个人本地访问、开发、研究和缓存，不应被描述为完整 Arweave 全节点或完全 trustless Gateway。

## 文档

- [使用方式手册](doc/使用方式手册.md)
- [安装与构建](doc/安装与构建.md)
- [开发架构手册](doc/开发架构手册.md)
- [缓存与 RPC 池](doc/缓存与RPC池.md)
- [兼容性测试](doc/兼容性测试.md)
