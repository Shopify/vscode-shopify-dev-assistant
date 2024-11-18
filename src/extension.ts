import * as vscode from 'vscode';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';

const OPEN_IN_GRAPHIQL_COMMAND_ID = 'shopify.open-in-graphiql';
const SHOPIFY_PARTICIPANT_ID = 'shopify';

interface IShopifyChatResult extends vscode.ChatResult {
  metadata: {
    command: string;
    codeBlocks?: string[];
  }
}

interface StreamToken {
  index: number;
  token: string;
  fail?: boolean;
  complete?: boolean;
}

function fromCamelToSnake(key: string): string {
  return key.replace(/([A-Z])/g, '_$1').toLowerCase();
}

function recurse(keyConverter: (key: string) => string, input: any): any {
  if (Array.isArray(input)) {
    return input.map(item => recurse(keyConverter, item));
  }

  if (input !== null && typeof input === 'object') {
    return Object.keys(input).reduce((acc, key) => {
      acc[keyConverter(key)] = recurse(keyConverter, input[key]);
      return acc;
    }, {} as Record<string, any>);
  }

  return input;
}

function objectKeysToSnakeCase<T>(input: any): T {
  return recurse(fromCamelToSnake, input) as T;
}

export function activate(context: vscode.ExtensionContext) {
  const handler: vscode.ChatRequestHandler = async (request: vscode.ChatRequest, _context: vscode.ChatContext, stream: vscode.ChatResponseStream, token: vscode.CancellationToken): Promise<IShopifyChatResult> => {
    let fragments: string[] = [];
    const streamId = uuidv4();

    // Replace EventSource with axios SSE implementation
    const response = await axios({
      method: 'post',
      url: 'https://shopify.dev/llm/gql_operations',
      responseType: 'stream',
      headers: {
        'Accept': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Content-Type': 'application/json',
      },
      data: objectKeysToSnakeCase({
        streamId,
        gqlOperation: {
          userPrompt: request.prompt,
        },
      }),
    });

    // Set up stream handling
    response.data.on('data', (chunk: Buffer) => {
      const lines = chunk.toString().split('\n');
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6); // Remove 'data: ' prefix
          try {
            const token: StreamToken = JSON.parse(data);
            stream.markdown(token.token);
            fragments.push(token.token);
            console.log('received', token.token);

            if (token.complete) {
              response.data.destroy(); // Close the stream
            }
          } catch (error) {
            console.error('Error parsing SSE data:', error);
          }
        }
      }
    });

    // Handle errors
    response.data.on('error', (error: Error) => {
      console.error('SSE Error:', error);
      response.data.destroy();
    });

    // Register cleanup when the token is cancelled
    token.onCancellationRequested(() => {
      response.data.destroy();
    });

    await queryLlmGqlOperations(request.prompt, stream, fragments);

    if (request.command === 'graphql') {
      return { metadata: {command: 'graphql'}};
    } else {
      return { metadata: {command: ''}};
    }
  };

  // Create the chat participant with the new API
  const agent = vscode.chat.createChatParticipant(SHOPIFY_PARTICIPANT_ID, handler);
  agent.iconPath = vscode.Uri.joinPath(context.extensionUri, 'shopify.svg');

  // Update followup provider to use the new API
  agent.followupProvider = {
    provideFollowups(result: IShopifyChatResult, context: vscode.ChatContext, token: vscode.CancellationToken) {
      return [{
        prompt: 'fix the error',
        label: vscode.l10n.t('Fix the error'),
        command: 'fix'
      } satisfies vscode.ChatFollowup];
    }
  };

  context.subscriptions.push(
    agent,
    vscode.commands.registerCommand(OPEN_IN_GRAPHIQL_COMMAND_ID, async ({codeBlocks}) => {
      const url = `http://localhost:3457/graphiql?query=${encodeURIComponent(codeBlocks[0])}`;
      const timeout = 30 * 1000;
      const interval = 1000;
      let intervalId: ReturnType<typeof setTimeout> | undefined;

      const message = vscode.window.setStatusBarMessage('Waiting for GraphiQL to be reachable');

      const timeoutId = setTimeout(() => {
        if (intervalId) {
          clearInterval(intervalId);
        }
        message.dispose();
        vscode.window.showErrorMessage("Couldn't reach GraphiQL.");
      }, timeout);

      const checkUrlAndOpen = async () => {
        await axios.get(url);
        clearTimeout(timeoutId);
        if (intervalId) {
          clearInterval(intervalId);
        }
        message.dispose();
        vscode.env.openExternal(vscode.Uri.parse(url));
      };

      try {
        await checkUrlAndOpen();
      } catch (error) {
        const terminal = vscode.window.createTerminal('Shopify Dev');
        terminal.sendText("dev cd cli && pnpm shopify app dev --path ~/Projects/vscode-agent-test");
        terminal.show();

        intervalId = setInterval(async () => {
          try {
            await checkUrlAndOpen();
          } catch (error) {
            // Ignore errors
          }
        }, interval);
      }
    })
  );
}

export function deactivate() {}

function extractCodeBlocks(lines: string[]): string[] {
  let inCodeBlock = false;
  let currentBlock = '';
  const codeBlocks: string[] = [];

  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      if (inCodeBlock) {
        // end of a code block
        inCodeBlock = false;
        codeBlocks.push(currentBlock);
        currentBlock = '';
      } else {
        // start of a code block
        inCodeBlock = true;
      }
    } else if (inCodeBlock) {
      currentBlock += line;
    }
  }

  return codeBlocks;
}

async function queryLlmGqlOperations(prompt: string, stream: vscode.ChatResponseStream, fragments: string[]): Promise<void> {
  await axios({
    method: 'post',
    url: 'https://shopify.dev/llm/gql_operations',
    data: {
      gql_operation: {
        user_prompt: prompt,
      },
      stream_id: '1234',
    },
  });

  stream.button({
    command: OPEN_IN_GRAPHIQL_COMMAND_ID,
    title: vscode.l10n.t('Open in GraphiQL'),
    arguments: [{ codeBlocks: extractCodeBlocks(fragments) }]
  });
}
