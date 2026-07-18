import { AdsClient } from '../internal/client/ads-client.js';
import { SpApiClient } from '../internal/client/client.js';
import { BrokerCredentialProvider, brokerConfigFromEnv } from '../internal/credential/broker.js';
import { LocalCredentialProvider } from '../internal/credential/local.js';
import { progress } from '../internal/errs/output.js';
import type { ToolContext } from './types.js';

export interface ToolClientFactories {
  spClient?: () => SpApiClient;
  adsClient?: () => AdsClient;
  progress?: (message: string) => void;
}

/** CLI 与 MCP 共用的惰性运行上下文；只访问实际需要的凭证体系。 */
export function buildToolContext(
  flags: Record<string, unknown>,
  factories: ToolClientFactories = {},
): ToolContext {
  let spClient: SpApiClient | undefined;
  let adsClient: AdsClient | undefined;
  return {
    get client(): SpApiClient {
      if (!spClient) {
        if (factories.spClient) {
          spClient = factories.spClient();
        } else {
          const brokerCfg = brokerConfigFromEnv();
          const provider = brokerCfg
            ? new BrokerCredentialProvider(brokerCfg)
            : LocalCredentialProvider.fromEnv();
          spClient = new SpApiClient(provider);
        }
      }
      return spClient;
    },
    get adsClient(): AdsClient {
      if (!adsClient) adsClient = factories.adsClient ? factories.adsClient() : new AdsClient();
      return adsClient;
    },
    flags,
    progress: factories.progress ?? progress,
  };
}
