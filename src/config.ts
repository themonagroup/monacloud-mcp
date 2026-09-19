import { homedir } from 'node:os';
import { join } from 'node:path';

export type Config = {
  issuer: string;
  billingUrl: string;
  monapayApi: string;
  monamailApi: string;
  vibecloudApi: string;
  consoleUrl: string;
  clientId: string;
  scope: string;
  configDir: string;
  tokenFile: string;
  linksFile: string;
  templatesDir: string;
  templatesUrl?: string;
  monapayLinkPath: string;
  vibecloudLinkPath: string;
};

const cleanBaseUrl = (value: string) => value.replace(/\/+$/, '');

export const DEFAULT_TEMPLATES_URL = 'https://raw.githubusercontent.com/themonagroup/mona-agent-templates/main';

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const configDir = env.MONACLOUD_CONFIG_DIR
    || join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'monacloud');
  return {
    issuer: cleanBaseUrl(env.MONACLOUD_ISSUER || 'https://pass.monacloud.vn/realms/mona'),
    billingUrl: cleanBaseUrl(env.MONACLOUD_BILLING_URL || 'https://billing.monacloud.vn'),
    monapayApi: cleanBaseUrl(env.MONAPAY_API || env.MONAPAY_BASE_URL || 'https://api.monapay.vn'),
    monamailApi: cleanBaseUrl(env.MONAMAIL_API || 'https://api.monamail.vn'),
    vibecloudApi: cleanBaseUrl(env.MONACLOUD_API || env.VIBECLOUD_API || env.VIBECLOUD_API_URL || 'https://api.monacloud.vn'),
    consoleUrl: cleanBaseUrl(env.MONACLOUD_CONSOLE_URL || 'https://monacloud.vn/console'),
    clientId: env.MONACLOUD_CLIENT_ID || 'monacloud-mcp',
    scope: env.MONACLOUD_SCOPE || 'openid profile email product billing-api offline_access',
    configDir,
    tokenFile: join(configDir, 'token.json'),
    linksFile: join(configDir, 'links.json'),
    templatesDir: env.MONACLOUD_TEMPLATES_DIR || join(homedir(), 'monacloud', 'templates'),
    // Catalog công khai mona-agent-templates (19/09/2026). Đặt MONACLOUD_TEMPLATES_URL="" để tắt remote (chỉ built-in/local).
    templatesUrl: env.MONACLOUD_TEMPLATES_URL === undefined
      ? DEFAULT_TEMPLATES_URL
      : (env.MONACLOUD_TEMPLATES_URL ? cleanBaseUrl(env.MONACLOUD_TEMPLATES_URL) : undefined),
    monapayLinkPath: env.MONAPAY_LINK_PATH || '/api/v1/client/oauth/mona-id/link',
    vibecloudLinkPath: env.VIBECLOUD_LINK_PATH || '/api/auth/monaid/link',
  };
}
