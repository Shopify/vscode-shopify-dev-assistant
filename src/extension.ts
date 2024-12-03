import * as vscode from 'vscode';
import { marked, TokensList } from 'marked';

const OPEN_IN_GRAPHIQL_COMMAND_ID = 'shopify.open-in-graphiql';
const SHOPIFY_PARTICIPANT_ID = 'shopify';
const CONVERT_TO_GRAPHQL_COMMAND_ID = 'shopify.convert-to-graphql';

interface IShopifyChatResult extends vscode.ChatResult {
  metadata: {
    threadId?: string;
    operationId?: string;
  }
}

export function extractMarkdownUrls(fullText: string): Set<string> {
  const urls = new Set<string>();
  const tokens = marked.lexer(fullText);

  function processTokens(tokens: TokensList) {
    tokens.forEach(token => {
      if (token.type === 'link' && 'href' in token && token.href.startsWith('http')) {
        urls.add(token.href);
      }
      if ('tokens' in token && Array.isArray(token.tokens)) {
        processTokens(token.tokens as TokensList);
      }
    });
  }

  processTokens(tokens);
  return urls;
}

export function extractCodeBlocks(fullText: string): string[] {
  const codeBlocks: string[] = [];
  const tokens = marked.lexer(fullText);
  tokens.forEach(token => {
    if (token.type === 'code' && token.lang === 'graphql') {
      codeBlocks.push(token.text.trim());
    }
  });
  return codeBlocks;
}

async function isShopifyApp(): Promise<boolean> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (workspaceFolder) {
    try {
      const shopifyTomlPath = vscode.Uri.joinPath(workspaceFolder.uri, 'shopify.app.toml');
      await vscode.workspace.fs.stat(shopifyTomlPath);
      return true;
    } catch (error) {
      console.log('Not a Shopify app - missing shopify.app.toml');
    }
  }
  return false;
}

export function sendFeedback(feedback: vscode.ChatResultFeedback) {
  const operationId = feedback.result.metadata?.operationId;

  if (operationId) {
    fetch(`https://shopify.dev/llm/gql_operations/${operationId}/feedback`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        gql_operation: {
          user_feedback: {
            helpfulness: feedback.kind === vscode.ChatResultFeedbackKind.Helpful,
            // we should be able to use feedback.unhelpfulReason, but it seems to be undefined (bug?)
            category: "other",
            user_feedback: "Submitted via VSCode extension"
          }
        }
      })
    }).catch(error => {
      console.error('Failed to send feedback:', error);
    });
  }
}

export const handler: vscode.ChatRequestHandler = async (request: vscode.ChatRequest, context: vscode.ChatContext, stream: vscode.ChatResponseStream, token: vscode.CancellationToken): Promise<IShopifyChatResult> => {
    let currentThreadId: string | undefined;
    let currentOperationId: string | undefined;

    if (context.history.length === 0) {
      currentThreadId = undefined;
    } else {
      const lastResponse = context.history[context.history.length - 1];
      if ('result' in lastResponse && lastResponse.result.metadata?.threadId) {
        currentThreadId = lastResponse.result.metadata.threadId;
      }
    }

    let fullText: string = '';
    const streamId = crypto.randomUUID();
    let currentEventType = '';
    let currentData: any;

    const response = await fetch('https://shopify.dev/llm/gql_operations', {
      method: 'POST',
      headers: {
        'Accept': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        stream_id: streamId,
        thread_id: currentThreadId,
        gql_operation: {
          user_prompt: request.prompt,
        },
      }),
    });

    if (!response.ok || !response.body) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();

    token.onCancellationRequested(() => {
      reader.cancel();
    });

    try {
      let result;
      let processedUrls = new Set<string>();

      while ((result = await reader.read()) && !result.done) {
        const chunk = decoder.decode(result.value);
        const lines = chunk.split('\n');

        for (const line of lines) {
          if (line.startsWith('event: ')) {
            currentEventType = line.slice(7);
          } else if (line.startsWith('data: ')) {
            currentData = JSON.parse(line.slice(6));

            try {
              switch (currentEventType) {
                case 'start':
                  currentThreadId = currentData;
                  break;
                case 'token':
                  stream.markdown(currentData);
                  fullText += currentData;

                  const currentUrls = extractMarkdownUrls(fullText);
                  for (const url of currentUrls) {
                    if (!processedUrls.has(url)) {
                      stream.reference(vscode.Uri.parse(url));
                      processedUrls.add(url);
                    }
                  }
                  break;

                case 'complete':
                  currentOperationId = currentData.gql_operation.id;
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

    const codeBlocks = extractCodeBlocks(fullText);
    if (codeBlocks.length > 0 && await isShopifyApp()) {
      stream.button({
          command: OPEN_IN_GRAPHIQL_COMMAND_ID,
          title: vscode.l10n.t('Open in GraphiQL'),
          arguments: [{ codeBlocks }]
      });
    }

    return {
      metadata: {
        threadId: currentThreadId,
        operationId: currentOperationId
      }
    };
};

const isGraphiQLReachable = async () => {
  try {
    await fetch('http://localhost:3457/graphiql');
    return true;
  } catch (error) {
    return false;
  }
};

const openGraphiQLURLs = (codeBlocks: string[]) => {
  const baseUrl = 'http://localhost:3457/graphiql';
  for (const block of codeBlocks) {
    const encodedQuery = encodeURIComponent(block).replace(/%20/g, '+');
    const url = `${baseUrl}?query=${encodedQuery}`;
    vscode.env.openExternal(vscode.Uri.parse(url));
  }
};

export function activate(extensionContext: vscode.ExtensionContext) {
  const agent = vscode.chat.createChatParticipant(SHOPIFY_PARTICIPANT_ID, handler);
  agent.iconPath = vscode.Uri.joinPath(extensionContext.extensionUri, 'icon.png');

  extensionContext.subscriptions.push(agent.onDidReceiveFeedback(sendFeedback));

  extensionContext.subscriptions.push(
    agent,
    vscode.commands.registerCommand(OPEN_IN_GRAPHIQL_COMMAND_ID, async ({ codeBlocks }) => {
      const timeout = 30 * 1000;
      const interval = 1000;
      let intervalId: ReturnType<typeof setInterval> | undefined;

      const message = vscode.window.setStatusBarMessage('Waiting for GraphiQL to be reachable');

      const timeoutId = setTimeout(() => {
        if (intervalId) {
          clearInterval(intervalId);
        }
        message.dispose();
        vscode.window.showErrorMessage("Couldn't reach GraphiQL.");
      }, timeout);

      if (!(await isGraphiQLReachable())) {
        // Start the dev server
        const terminal = vscode.window.createTerminal('Shopify Dev');
        terminal.sendText('npm run shopify app dev');
        terminal.show();

        // Retry until the server becomes accessible
        intervalId = setInterval(async () => {
          if (await isGraphiQLReachable()) {
            clearTimeout(timeoutId);
            if (intervalId) {
              clearInterval(intervalId);
            }
            message.dispose();
            openGraphiQLURLs(codeBlocks);
          }
        }, interval);
      } else {
        openGraphiQLURLs(codeBlocks);
        clearTimeout(timeoutId);
        message.dispose();
      }
    }),
    vscode.commands.registerCommand(CONVERT_TO_GRAPHQL_COMMAND_ID, async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        return;
      }

      const selection = editor.selection;
      const selectedText = editor.document.getText(selection);

      if (!selectedText) {
        vscode.window.showWarningMessage('Please select some text to convert to GraphQL');
        return;
      }

      const prompt = `@shopify I want to convert the following code wrapped in triple backticks to GraphQL:

\`\`\`
${selectedText}
\`\`\``;

      await vscode.commands.executeCommand('workbench.action.chat.open', prompt);
    })
  );
}

export function deactivate() {}
