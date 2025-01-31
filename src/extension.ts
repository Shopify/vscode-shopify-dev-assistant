import * as vscode from 'vscode';
import { marked, TokensList } from 'marked';
import { createParser } from 'eventsource-parser';
import { renderPrompt } from '@vscode/prompt-tsx';
import { UserPrompt } from './userPrompt';
import { LanguageModelTextPart } from 'vscode';

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
      if (
        token.type === 'link' &&
        'href' in token &&
        token.href.startsWith('http') &&
        token.raw.endsWith(')')
      ) {
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

// export function extractCodeBlocks(fullText: string): string[] {
//   const codeBlocks: string[] = [];
//   const tokens = marked.lexer(fullText);
//   tokens.forEach(token => {
//     if (token.type === 'code' && token.lang === 'graphql') {
//       codeBlocks.push(token.text.trim());
//     }
//   });
//   return codeBlocks;
// }

interface GraphQLBlock {
  query: string;
  variables?: string;
}

export function extractCodeBlocks(fullText: string): GraphQLBlock[] {
  const blocks: GraphQLBlock[] = [];
  const tokens = marked.lexer(fullText);
  let currentQuery: string | null = null;

  tokens.forEach(token => {
    if (token.type === 'code') {
      if (token.lang === 'graphql') {
        currentQuery = token.text.trim();
      } else if (token.lang === 'json' && currentQuery) {
        blocks.push({
          query: currentQuery,
          variables: token.text.trim()
        });
        currentQuery = null;
      }
    }
  });

  return blocks;
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
        'Content-Type': 'application/json',
        'X-Shopify-Surface': 'vscode'
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

  const processedUrls = new Set<string>();
  let fullText = '';

  const parser = createParser({
    onEvent: (event) => {
      const eventType = event.event;
      const data = JSON.parse(event.data);

      switch (eventType) {
        case 'start':
          currentThreadId = data;
          break;
        case 'token':
          const tokenText = data;
          stream.markdown(tokenText);
          fullText += tokenText;

          // Extract URLs from the current fullText
          const urls = extractMarkdownUrls(fullText);
          for (const url of urls) {
            if (!processedUrls.has(url)) {
              // Stream reference after the link has been closed
              stream.reference(vscode.Uri.parse(url));
              processedUrls.add(url);
            }
          }
          break;
        case 'complete':
          currentOperationId = data.gql_operation.id;
          break;
        case 'error':
        case 'openai_error':
          throw new Error(data);
      }
    },
    onError: (error) => {
      throw error;
    }
  });

  const streamId = crypto.randomUUID();
  const models = await vscode.lm.selectChatModels({ family: 'gpt-4o' });
  const model = models[0];

  const { messages, references } = await renderPrompt(
    UserPrompt,
    { request },
    { modelMaxPromptTokens: model.maxInputTokens },
    model
  );

  references.forEach(ref => {
    if (ref.anchor instanceof vscode.Uri || ref.anchor instanceof vscode.Location) {
      stream.reference(ref.anchor);
    }
  });

  const prompt = (messages[0].content[0] as LanguageModelTextPart).value;

  const response = await fetch('https://shopify.dev/llm/gql_operations', {
    method: 'POST',
    headers: {
      'Accept': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Content-Type': 'application/json',
      'X-Shopify-Surface': 'vscode'
    },
    body: JSON.stringify({
      stream_id: streamId,
      thread_id: currentThreadId,
      gql_operation: {
        user_prompt: prompt,
      },
    }),
  });

  if (!response.ok || !response.body) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  token.onCancellationRequested(() => {
    reader.cancel();
  });

  try {
    let result;

    while ((result = await reader.read()) && !result.done) {
      const chunk = decoder.decode(result.value);
      parser.feed(chunk);
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

// const openGraphiQLURLs = (codeBlocks: string[]) => {
//   const baseUrl = 'http://localhost:3457/graphiql';
//   for (const block of codeBlocks) {
//     const encodedQuery = encodeURIComponent(block).replace(/%20/g, '+');
//     const url = `${baseUrl}?query=${encodedQuery}`;
//     vscode.env.openExternal(vscode.Uri.parse(url));
//   }
// };

const openGraphiQLURLs = (codeBlocks: GraphQLBlock[]) => {
  const baseUrl = 'http://localhost:3457/graphiql';
  for (const block of codeBlocks) {
    const encodedQuery = encodeURIComponent(block.query).replace(/%20/g, '+');
    let url = `${baseUrl}?query=${encodedQuery}`;
    
    if (block.variables) {
      const encodedVariables = encodeURIComponent(block.variables).replace(/%20/g, '+');
      url += `&variables=${encodedVariables}`;
    }
    
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
      if (!(await isGraphiQLReachable())) {
        const timeout = 30 * 1000;
        const interval = 1000;

        const terminal = vscode.window.createTerminal('Shopify Dev');
        terminal.sendText('npm run shopify app dev');
        terminal.show();

        const message = vscode.window.setStatusBarMessage('Waiting for GraphiQL to be reachable');

        const timeoutId = setTimeout(() => {
          clearInterval(intervalId);
          message.dispose();
          vscode.window.showErrorMessage("Couldn't reach GraphiQL.");
        }, timeout);

        const intervalId = setInterval(async () => {
          if (await isGraphiQLReachable()) {
            clearTimeout(timeoutId);
            clearInterval(intervalId);
            message.dispose();
            openGraphiQLURLs(codeBlocks);
          }
        }, interval);
      } else {
        openGraphiQLURLs(codeBlocks);
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

      const prompt = `@shopify I want to convert the following code to GraphQL:

\`\`\`
${selectedText}
\`\`\``;

      await vscode.commands.executeCommand('workbench.action.chat.open', prompt);
    })
  );
}

export function deactivate() {}
