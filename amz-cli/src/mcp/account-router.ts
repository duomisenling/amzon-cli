import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type CallToolRequestParams,
  type CallToolResult,
  type ListToolsResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { readPackageInfo } from '../internal/package-info.js';

export interface AccountToolClient {
  listTools(): Promise<ListToolsResult>;
  callTool(params: CallToolRequestParams): Promise<CallToolResult>;
  close(): Promise<void>;
}

export type AccountToolConnector = (account: string) => Promise<AccountToolClient>;

interface AccountRouterOptions {
  connector: AccountToolConnector;
  version?: string;
}

function addAccountInput(tool: Tool, accounts: readonly string[], schemaAccount: string): Tool {
  const schema = tool.inputSchema as {
    type: 'object';
    properties?: Record<string, unknown>;
    required?: string[];
    [key: string]: unknown;
  };
  const required = new Set(schema.required ?? []);
  required.add('account');
  const fixedPrefix = `【${schemaAccount}】`;
  const originalTitle = tool.title?.startsWith(fixedPrefix)
    ? tool.title.slice(fixedPrefix.length)
    : (tool.title ?? tool.name);
  const originalDescription = tool.description?.replaceAll(schemaAccount, '所选店铺') ?? '';

  return {
    ...tool,
    title: `【多店铺】${originalTitle}`,
    description:
      `必须通过 account 明确选择目标店铺，可选：${accounts.join(' / ')}。` +
      `AI 应复用当前对话已经明确的店铺；不明确时先追问，禁止猜测。${originalDescription}`,
    inputSchema: {
      ...schema,
      properties: {
        account: {
          type: 'string',
          enum: [...accounts],
          description: '目标店铺代号。必须与当前对话中的店铺一致；写操作不得使用默认店铺猜测。',
        },
        ...(schema.properties ?? {}),
      },
      required: [...required],
    },
  };
}

/**
 * Cherry 只连接这一台路由 MCP；每个账号仍由独立的固定账号子进程执行。
 * 这样 account 可以作为工具必填参数，同时避免并发调用通过 process.env 串用凭证。
 */
export class MultiAccountMcpRouter {
  readonly server: Server;
  private readonly clients = new Map<string, Promise<AccountToolClient>>();
  private toolsPromise?: Promise<Tool[]>;

  constructor(
    readonly accounts: readonly string[],
    private readonly options: AccountRouterOptions,
  ) {
    if (accounts.length === 0) throw new Error('multi-account MCP router requires at least one account');
    this.server = new Server(
      // 版本从随包 package.json 动态读取,避免与 npm 版本漂移;options.version 仍可覆盖
      { name: 'amz-cli-safe-writes-multi-account', version: options.version ?? readPackageInfo().version },
      { capabilities: { tools: {} } },
    );
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: await this.listRoutedTools(),
    }));
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const rawArgs = request.params.arguments;
      if (!rawArgs || typeof rawArgs !== 'object' || Array.isArray(rawArgs)) {
        throw new McpError(ErrorCode.InvalidParams, '工具调用缺少参数对象，必须明确提供 account');
      }
      const account = rawArgs['account'];
      // 账号名大小写不敏感:把请求值归一到配置里的规范名(如 shopa → ShopA),
      // 再按规范名路由到隔离子进程,子进程返回的也是规范名。
      const canonical =
        typeof account === 'string'
          ? this.accounts.find((a) => a.toLowerCase() === account.toLowerCase())
          : undefined;
      if (!canonical) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `account 无效或未提供；必须明确选择:${this.accounts.join(' / ')}`,
        );
      }

      const childArgs = { ...rawArgs };
      delete childArgs['account'];
      const result = await this.withAccountClient(canonical, (client) =>
        client.callTool({
          name: request.params.name,
          arguments: childArgs,
        }),
      );
      // 回验也必须大小写不敏感:子进程的 loadAccount 会把账号名归一到凭证文件的
      // 实际大小写(shopa → ShopA.env 返回 "ShopA"),与 --accounts 里的写法
      // 可能只差大小写。严格比较会把每次成功调用都误判成路由失败。
      const returned = result.structuredContent?.['account'];
      if (
        !result.isError &&
        (typeof returned !== 'string' || returned.toLowerCase() !== canonical.toLowerCase())
      ) {
        throw new McpError(
          ErrorCode.InternalError,
          `店铺路由校验失败:请求 ${canonical},子进程返回 ${String(returned)}`,
        );
      }
      return result;
    });
    this.server.onclose = () => {
      void this.closeClients();
    };
  }

  connect(transport: Transport): Promise<void> {
    return this.server.connect(transport);
  }

  async close(): Promise<void> {
    await this.closeClients();
    await this.server.close();
  }

  private async closeClients(): Promise<void> {
    const clients = [...this.clients.values()];
    this.clients.clear();
    this.toolsPromise = undefined;
    await Promise.allSettled(
      clients.map(async (clientPromise) => {
        const client = await clientPromise;
        await client.close();
      }),
    );
  }

  private async listRoutedTools(): Promise<Tool[]> {
    if (!this.toolsPromise) {
      this.toolsPromise = (async () => {
        const schemaAccount = this.accounts[0]!;
        const listed = await this.withAccountClient(schemaAccount, (client) => client.listTools());
        return listed.tools.map((tool) => addAccountInput(tool, this.accounts, schemaAccount));
      })().catch((error: unknown) => {
        this.toolsPromise = undefined;
        throw error;
      });
    }
    return this.toolsPromise;
  }

  /**
   * 拿该账号的 client 执行一次调用;遇到"连接已关闭/transport"类错误
   * (子进程崩溃或退出后 SDK 抛的就是这种)时,清掉缓存重连并重试一次。
   * 只重试一次:重连后仍失败说明子进程起不来,直接把错误抛给调用方,防死循环。
   */
  private async withAccountClient<T>(
    account: string,
    action: (client: AccountToolClient) => Promise<T>,
  ): Promise<T> {
    const cached = this.clientFor(account);
    const client = await cached;
    try {
      return await action(client);
    } catch (error) {
      if (!isTransportClosedError(error)) throw error;
      // 只在缓存还是"这一个失效 client"时才删:并发调用可能已经重连过了,
      // 不能把别人刚建好的新连接一并删掉。
      if (this.clients.get(account) === cached) this.clients.delete(account);
      void Promise.resolve(client.close()).catch(() => {});
      const fresh = await this.clientFor(account);
      return action(fresh);
    }
  }

  private clientFor(account: string): Promise<AccountToolClient> {
    let client = this.clients.get(account);
    if (!client) {
      client = this.options.connector(account).catch((error: unknown) => {
        this.clients.delete(account);
        throw error;
      });
      this.clients.set(account, client);
    }
    return client;
  }
}

/** 是否是"底层连接已断"类错误:SDK 在子进程退出后抛 "Connection closed" / "Not connected"。 */
function isTransportClosedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /connection closed|not connected|transport (?:is )?closed|EPIPE|ECONNRESET/i.test(message);
}

function inheritedEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}

export function createStdioAccountConnector(options: {
  serverPath: string;
  execPath?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  version?: string;
}): AccountToolConnector {
  return async (account: string) => {
    const transport = new StdioClientTransport({
      command: options.execPath ?? process.execPath,
      args: [options.serverPath, '--account', account],
      cwd: options.cwd ?? process.cwd(),
      env: inheritedEnvironment(options.env ?? process.env),
      stderr: 'inherit',
    });
    const client = new Client({
      name: `amz-cli-account-router-${account}`,
      version: options.version ?? readPackageInfo().version,
    });
    await client.connect(transport);
    return {
      listTools: () => client.listTools(),
      callTool: async (params) => (await client.callTool(params)) as CallToolResult,
      close: () => client.close(),
    };
  };
}
