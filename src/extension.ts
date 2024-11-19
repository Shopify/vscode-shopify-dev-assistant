import * as vscode from 'vscode';
import { v4 as uuidv4 } from 'uuid';

const OPEN_IN_GRAPHIQL_COMMAND_ID = 'shopify.open-in-graphiql';
const SHOPIFY_PARTICIPANT_ID = 'shopify';

interface IShopifyChatResult extends vscode.ChatResult {
  metadata: {
    command: string;
    codeBlocks?: string[];
  }
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
    let currentEventType = '';
    let currentData = '';

    const response = await fetch('https://shopify.dev/llm/gql_operations', {
      method: 'POST',
      headers: {
        'Accept': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(objectKeysToSnakeCase({
        streamId,
        gqlOperation: {
          userPrompt: request.prompt,
        },
      })),
    });

    if (!response.ok || !response.body) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    // Register cleanup when the token is cancelled
    token.onCancellationRequested(() => {
      reader.cancel();
    });

    try {
      let result;
      while ((result = await reader.read()) && !result.done) {
        const chunk = decoder.decode(result.value);
        const lines = chunk.split('\n');

        for (const line of lines) {
          if (line.startsWith('event: ')) {
            currentEventType = line.slice(7);
          } else if (line.startsWith('data: ')) {
            currentData = line.slice(6);

            try {
              switch (currentEventType) {
                case 'token':
                  stream.markdown(currentData);
                  fragments.push(currentData);
                  break;

                case 'complete':
                  break;

                case 'error':
                case 'openai_error':
                  console.error(`${currentEventType}:`, currentData);
                  throw new Error(currentData);
              }
            } catch (error) {
              console.error('Error processing SSE data:', error);
              throw error;
            }
          }
        }
      }
    } catch (error) {
      console.error('SSE Error:', error);
      throw error;
    } finally {
      reader.cancel();
    }

    stream.button({
      command: OPEN_IN_GRAPHIQL_COMMAND_ID,
      title: vscode.l10n.t('Open in GraphiQL'),
      arguments: [{ codeBlocks: extractCodeBlocks(fragments) }]
    });

    return { metadata: { command: '' } };
  };

  // Create the chat participant with the new API
  const agent = vscode.chat.createChatParticipant(SHOPIFY_PARTICIPANT_ID, handler);
  agent.iconPath = vscode.Uri.joinPath(context.extensionUri, 'shopify.svg');

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
        await fetch(url);
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
