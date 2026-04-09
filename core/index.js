const { createBridgeConfig } = require('./bridge/bridge-config');
const { createMindGraphBridge } = require('./bridge/mindgraph-bridge');

function initializeCoreBridge({
  eventBus,
  logger = console,
  env = process.env
} = {}) {
  if (!eventBus) {
    throw new Error('initializeCoreBridge requires an eventBus instance');
  }

  const bridgeConfig = createBridgeConfig(env);
  if (!bridgeConfig.enabled) {
    return null;
  }
  if (!bridgeConfig.authSecret) {
    logger.error('[mindgraph-bridge] MINDGRAPH_BRIDGE_SECRET is required when bridge is enabled');
    return null;
  }

  const bridge = createMindGraphBridge({
    eventBus,
    config: bridgeConfig,
    logger
  });
  bridge.start();
  return bridge;
}

module.exports = {
  initializeCoreBridge
};
