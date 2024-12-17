import * as assert from 'assert';
import * as vscode from 'vscode';
import { extractMarkdownUrls, extractCodeBlocks, handler, sendFeedback } from '../extension';
import * as sinon from 'sinon';

suite('Unit Test Suite', () => {
  test('extractMarkdownUrls extracts correct URLs', () => {
    const testText = 'Here is a [link](https://example.com) and [another](https://test.com)';
    const urls = extractMarkdownUrls(testText);

    assert.strictEqual(urls.size, 2);
    assert.ok(urls.has('https://example.com'));
    assert.ok(urls.has('https://test.com'));
  });

  test('extractMarkdownUrls ignores non-http URLs', () => {
    const testText = '[local](file://test) and [web](https://example.com)';
    const urls = extractMarkdownUrls(testText);

    assert.strictEqual(urls.size, 1);
    assert.ok(urls.has('https://example.com'));
  });

  test('extractCodeBlocks finds GraphQL blocks', () => {
    const testText = '```graphql\nquery { test }\n```\nSome text\n```graphql\nmutation { update }\n```';
    const blocks = extractCodeBlocks(testText);

    assert.strictEqual(blocks.length, 2);
    assert.strictEqual(blocks[0].trim(), 'query { test }');
    assert.strictEqual(blocks[1].trim(), 'mutation { update }');
  });

  test('extractCodeBlocks ignores non-GraphQL blocks', () => {
    const testText = '```javascript\nconst x = 1;\n```\n```graphql\nquery { test }\n```';
    const blocks = extractCodeBlocks(testText);

    assert.strictEqual(blocks.length, 1);
    assert.strictEqual(blocks[0].trim(), 'query { test }');
  });

  test('extractMarkdownUrls ignores incomplete URLs during streaming', () => {
    const testText = 'Streaming text with incomplete [link](https://shopify.dev/ap';
    const urls = extractMarkdownUrls(testText);

    assert.strictEqual(urls.size, 0, 'Should not include incomplete URLs');
  });
});

suite('Integration Test Suite', () => {
  let sandbox: sinon.SinonSandbox;

  setup(() => {
    sandbox = sinon.createSandbox();
  });

  teardown(() => {
    sandbox.restore();
  });

  test('Chat handler processes stream correctly', async () => {
    sandbox.stub(vscode.lm, 'selectChatModels').resolves([{
      id: 'test-model-id',
      name: 'test-model',
      vendor: 'test-vendor',
      family: 'gpt-4o',
      version: '1',
      maxInputTokens: 4000,
      sendRequest: async () => ({}) as any,
      countTokens: async () => ({}) as any
    }]);

    global.fetch = async () => {
      let firstCall = true;
      return {
        ok: true,
        body: {
          getReader: () => ({
            read: async () => {
              if (firstCall) {
                firstCall = false;
                return {
                  done: false,
                  value: new TextEncoder().encode(
                    'event: start\ndata: "test-thread-id"\n\n' +
                    'event: token\ndata: "Hello [world](https://example.com)"\n\n' +
                    'event: complete\ndata: {"gql_operation":{"id":"test-op-id"}}\n\n'
                  )
                };
              }
              return { done: true, value: undefined };
            },
            cancel: () => {}
          })
        }
      } as any;
    };

    const request: vscode.ChatRequest = {
      prompt: 'test prompt',
      command: 'shopify.convert-to-graphql',
      references: [],
      toolReferences: [],
      toolInvocationToken: '' as never,
      model: {} as vscode.LanguageModelChat
    };
    const context = { history: [] };

    // Define the interface for the stubbed stream
    interface StubbedChatResponseStream extends vscode.ChatResponseStream {
      markdown: sinon.SinonStub;
      reference: sinon.SinonStub;
      button: sinon.SinonStub;
      anchor: sinon.SinonStub;
      filetree: sinon.SinonStub;
      progress: sinon.SinonStub;
      push: sinon.SinonStub;
    }

    const stream: StubbedChatResponseStream = {
      markdown: sandbox.stub(),
      reference: sandbox.stub(),
      button: sandbox.stub(),
      anchor: sandbox.stub(),
      filetree: sandbox.stub(),
      progress: sandbox.stub(),
      push: sandbox.stub(),
    };

    const token = new vscode.CancellationTokenSource().token;

    const result = await handler(request, context, stream, token);

    assert.ok(result?.metadata?.threadId);
    assert.ok(result?.metadata?.operationId);
    assert.strictEqual(result.metadata.threadId, 'test-thread-id');
    assert.strictEqual(result.metadata.operationId, 'test-op-id');

    // Assert that stream.markdown was called with the markdown text
    assert.ok(stream.markdown.calledWith('Hello [world](https://example.com)'));

    // Assert that stream.reference was called with the correct URI
    assert.ok(stream.reference.calledWith(vscode.Uri.parse('https://example.com')));
  });

  test('open-in-graphiql opens the correct URLs', async () => {
    const codeBlocks = ['query { test }', 'mutation { update }'];

    global.fetch = (async (input: Request | URL, init?: RequestInit) => {
      return {
        ok: true,
      } as Response;
    }) as typeof fetch;

    const openExternalStub = sandbox.stub(vscode.env, 'openExternal').resolves(true);

    await vscode.commands.executeCommand('shopify.open-in-graphiql', { codeBlocks });

    assert.strictEqual(openExternalStub.callCount, codeBlocks.length);
    for (let i = 0; i < codeBlocks.length; i++) {
      const encodedQuery = encodeURIComponent(codeBlocks[i]).replace(/%20/g, '+');
      const expectedUrl = `http://localhost:3457/graphiql?query=${encodedQuery}`;
      assert.ok(openExternalStub.getCall(i).calledWith(vscode.Uri.parse(expectedUrl)));
    }
  });

  test('convert-to-graphql command opens chat with correct prompt', async () => {
    const mockEditor = {
      document: {
        getText: (selection: any) => 'const x = 42;'
      },
      selection: {}
    };
    sandbox.stub(vscode.window, 'activeTextEditor').value(mockEditor);

    const showWarningMessageStub = sandbox.stub(vscode.window, 'showWarningMessage');

    const executeCommandStub = sandbox.stub(vscode.commands, 'executeCommand').callThrough();

    await vscode.commands.executeCommand('shopify.convert-to-graphql');

    assert.ok(
      executeCommandStub.calledWith(
        'workbench.action.chat.open',
        `@shopify I want to convert the following code to GraphQL:\n\n\`\`\`\nconst x = 42;\n\`\`\``
      )
    );

    assert.ok(
      showWarningMessageStub.notCalled
    );
  });

  test('convert-to-graphql command shows warning when no text is selected', async () => {
    const mockEditor = {
      document: {
        getText: (selection: any) => ''
      },
      selection: {}
    };
    sandbox.stub(vscode.window, 'activeTextEditor').value(mockEditor);

    const showWarningMessageStub = sandbox.stub(vscode.window, 'showWarningMessage');

    await vscode.commands.executeCommand('shopify.convert-to-graphql');

    assert.ok(
      showWarningMessageStub.calledWith(
        'Please select some text to convert to GraphQL'
      )
    );
  });

  test('open-in-graphiql runs dev server when GraphiQL is not reachable', async function() {
    const clock = sandbox.useFakeTimers();

    const codeBlocks = ['query { test }'];

    let fetchCallCount = 0;

    global.fetch = (async (input: Request | URL, init?: RequestInit) => {
      fetchCallCount++;
      if (fetchCallCount === 1) {
        throw new Error('Failed to fetch');
      } else {
        return {
          ok: true,
        } as Response;
      }
    }) as typeof fetch;

    const openExternalStub = sandbox.stub(vscode.env, 'openExternal').resolves(true);

    const sendTextStub = sandbox.stub();
    const showStub = sandbox.stub();
    const createTerminalStub = sandbox.stub(vscode.window, 'createTerminal').returns({
      sendText: sendTextStub,
      show: showStub,
    } as any);

    sandbox.stub(vscode.window, 'setStatusBarMessage').returns({
      dispose: sandbox.stub(),
    } as any);

    const commandPromise = vscode.commands.executeCommand('shopify.open-in-graphiql', { codeBlocks });

    await clock.tickAsync(1100);

    await commandPromise;

    assert.ok(createTerminalStub.calledOnce);
    assert.strictEqual(createTerminalStub.firstCall.args[0], 'Shopify Dev');

    assert.ok(sendTextStub.calledOnceWithExactly('npm run shopify app dev'));
    assert.ok(showStub.calledOnce);

    assert.ok(openExternalStub.calledOnce);

    assert.ok(fetchCallCount >= 2);

    clock.restore();
  });

  test('sendFeedback sends feedback to the server', async () => {
    const fetchStub = sandbox.stub(global, 'fetch').resolves({ ok: true } as Response);
    const feedback: vscode.ChatResultFeedback = {
      kind: vscode.ChatResultFeedbackKind.Helpful,
      result: {
        metadata: {
          operationId: 'test-operation-id'
        }
      }
    };

    sendFeedback(feedback);

    assert.ok(fetchStub.calledOnce);
    assert.strictEqual(
      fetchStub.firstCall.args[0],
      'https://shopify.dev/llm/gql_operations/test-operation-id/feedback'
    );
    const body = JSON.parse(fetchStub.firstCall.args[1]?.body as string);
    assert.deepStrictEqual(body, {
      gql_operation: {
        user_feedback: {
          helpfulness: true,
          category: 'other',
          user_feedback: 'Submitted via VSCode extension'
        }
      }
    });
  });
});
