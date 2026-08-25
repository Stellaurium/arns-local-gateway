import { loadConfig } from './config.js';
import { createGatewayServer } from './proxy.js';
import { createNativeGatewayServer } from './native/gateway.js';

const config = loadConfig();
const server = config.gatewayMode === 'proxy'
  ? createGatewayServer(config)
  : createNativeGatewayServer(config);

server.listen(config.port, config.host, () => {
  console.log(`\nArNS Local Gateway 已启动：`);
  console.log(`  入口：http://${config.localRootHost}:${config.port}/`);
  console.log(`  示例：http://permapages.${config.localRootHost}:${config.port}/`);
  console.log(`  模式：${config.gatewayMode}`);
  if (config.gatewayMode === 'native') {
    console.log(`  ArNS：Solana RPC 直接解析`);
    console.log(`  RPC：${config.solanaRpcUrls.join(', ')}`);
    console.log(`  Bundle 索引：${config.bundleIndexUrls.join(', ')}`);
    console.log(`  Arweave 节点：${config.arweavePeers.join(', ')}`);
    console.log(`  永久对象库：${config.dataDir}\n`);
  } else {
    console.log(`  上游：${config.upstreamGateways.join(', ')}`);
    console.log(`  缓存：${config.cacheDir}\n`);
  }
});

function shutdown(signal) {
  console.log(`\n收到 ${signal}，正在停止...`);
  server.close(() => process.exit(0));
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
