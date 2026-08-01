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
      { name: 'amz-cli-safe-writes-multi-account', version: options.version ?? '0.2.6' },
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
      // 账号名大小写不敏感:把请求值归一到配置里的规范名(如 cycayit → Cycayit),
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
      const client = await this.clientFor(canonical);
      const result = await client.callTool({
        name: request.params.name,
        arguments: childArgs,
      });
      if (!result.isError && result.structuredContent?.['account'] !== canonical) {
        throw new McpError(
          ErrorCode.InternalError,
          `店铺路由校验失败:请求 ${canonical},子进程返回 ${String(result.structuredContent?.['account'])}`,
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
        const source = await this.clientFor(schemaAccount);
        const listed = await source.listTools();
        return listed.tools.map((tool) => addAccountInput(tool, this.accounts, schemaAccount));
      })().catch((error: unknown) => {
        this.toolsPromise = undefined;
        throw error;
      });
    }
    return this.toolsPromise;
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
      version: options.version ?? '0.2.6',
    });
    await client.connect(transport);
    return {
      listTools: () => client.listTools(),
      callTool: async (params) => (await client.callTool(params)) as CallToolResult,
      close: () => client.close(),
    };
  };
}
