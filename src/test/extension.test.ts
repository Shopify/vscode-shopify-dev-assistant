import * as assert from 'assert';
import * as vscode from 'vscode';
import { extractMarkdownUrls, extractCodeBlocks, handler } from '../extension';
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
        // Mock the fetch API
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
                                        'event: token\ndata: "Hello world"\n\n' +
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

        // Create mock objects with required properties
        const request: vscode.ChatRequest = {
            prompt: 'test prompt',
            command: 'shopify.convert-to-graphql',
            references: [],
            toolReferences: [],
            toolInvocationToken: '' as never,
            model: { } as vscode.LanguageModelChat
        };
        const context = { history: [] };
        const stream: vscode.ChatResponseStream = {
            markdown: (text: string) => {},
            reference: (uri: vscode.Uri) => {},
            button: (options: any) => {},
            anchor: (value: vscode.Uri | vscode.Location, title?: string) => {},
            filetree: (options: any) => {},
            progress: (options: any) => {},
            push: (options: any) => {}
        };
        const token = new vscode.CancellationTokenSource().token;

        const result = await handler(request, context, stream, token);

        // Add null checks for type safety
        assert.ok(result?.metadata?.threadId);
        assert.ok(result?.metadata?.operationId);
        assert.strictEqual(result.metadata.threadId, 'test-thread-id');
        assert.strictEqual(result.metadata.operationId, 'test-op-id');
    });

    test('OPEN_IN_GRAPHIQL_COMMAND_ID opens the correct URLs', async () => {
        // Mock the codeBlocks that would be passed to the command
        const codeBlocks = ['query { test }', 'mutation { update }'];

        // Mock the fetch API to simulate successful responses
        global.fetch = (async (input: Request | URL, init?: RequestInit) => {
            return {
                ok: true,
                // Additional properties if needed
            } as Response;
        }) as typeof fetch;

        // Stub vscode.env.openExternal to monitor its calls
        const openExternalStub = sandbox.stub(vscode.env, 'openExternal').resolves(true);

        // Execute the command with the mock codeBlocks
        await vscode.commands.executeCommand('shopify.open-in-graphiql', { codeBlocks });

        // Verify that openExternal was called with the correct URLs
        assert.strictEqual(openExternalStub.callCount, codeBlocks.length);
        for (let i = 0; i < codeBlocks.length; i++) {
            const encodedQuery = encodeURIComponent(codeBlocks[i]).replace(/%20/g, '+');
            const expectedUrl = `http://localhost:3457/graphiql?query=${encodedQuery}`;
            assert.ok(openExternalStub.getCall(i).calledWith(vscode.Uri.parse(expectedUrl)));
        }
    });

    test('convert-to-graphql command opens chat with correct prompt', async () => {
        // Mock the active text editor with selected text
        const mockEditor = {
            document: {
                getText: (selection: any) => 'const x = 42;'
            },
            selection: {}
        };
        const activeTextEditorStub = sandbox.stub(vscode.window, 'activeTextEditor').value(mockEditor);

        // Stub showWarningMessage to monitor warnings
        const showWarningMessageStub = sandbox.stub(vscode.window, 'showWarningMessage');

        // Stub executeCommand to monitor command executions
        const executeCommandStub = sandbox.stub(vscode.commands, 'executeCommand').callThrough();

        // Execute the command
        await vscode.commands.executeCommand('shopify.convert-to-graphql');

        // Verify that the chat was opened with the correct prompt
        assert.ok(
            executeCommandStub.calledWith(
                'workbench.action.chat.open',
                `@shopify I want to convert the following code wrapped in triple backticks to GraphQL:\n\n\`\`\`\nconst x = 42;\n\`\`\``
            )
        );

        // Ensure no warning message was shown
        assert.ok(
            showWarningMessageStub.notCalled
        );
    });

    test('convert-to-graphql command shows warning when no text is selected', async () => {
        // Mock the active text editor without selected text
        const mockEditor = {
            document: {
                getText: (selection: any) => ''
            },
            selection: {}
        };
        const activeTextEditorStub = sandbox.stub(vscode.window, 'activeTextEditor').value(mockEditor);

        // Stub showWarningMessage to monitor warnings
        const showWarningMessageStub = sandbox.stub(vscode.window, 'showWarningMessage');

        // Execute the command
        await vscode.commands.executeCommand('shopify.convert-to-graphql');

        // Verify that a warning message was shown
        assert.ok(
            showWarningMessageStub.calledWith(
                'Please select some text to convert to GraphQL'
            )
        );
    });

    test('OPEN_IN_GRAPHIQL_COMMAND_ID runs dev server when GraphiQL is not reachable', async function() {
        // Use fake timers to control time in the test
        const clock = sandbox.useFakeTimers();

        // Mock the codeBlocks that would be passed to the command
        const codeBlocks = ['query { test }'];

        // A counter to simulate fetch failing initially and succeeding afterwards
        let fetchCallCount = 0;

        // Mock the fetch API to simulate GraphiQL not being reachable at first
        global.fetch = (async (input: Request | URL, init?: RequestInit) => {
            fetchCallCount++;
            if (fetchCallCount === 1) {
                // First call fails to simulate GraphiQL not running
                throw new Error('Failed to fetch');
            } else {
                // Subsequent calls succeed to simulate GraphiQL becoming reachable
                return {
                    ok: true,
                } as Response;
            }
        }) as typeof fetch;

        // Stub vscode.env.openExternal to monitor its calls
        const openExternalStub = sandbox.stub(vscode.env, 'openExternal').resolves(true);

        // Stub vscode.window.createTerminal to monitor terminal creation and commands sent
        const sendTextStub = sandbox.stub();
        const showStub = sandbox.stub();
        const createTerminalStub = sandbox.stub(vscode.window, 'createTerminal').returns({
            sendText: sendTextStub,
            show: showStub,
        } as any);

        // Stub vscode.window.setStatusBarMessage to avoid UI updates during the test
        const setStatusBarMessageStub = sandbox.stub(vscode.window, 'setStatusBarMessage').returns({
            dispose: sandbox.stub(),
        } as any);

        // Execute the command with the mock codeBlocks
        const commandPromise = vscode.commands.executeCommand('shopify.open-in-graphiql', { codeBlocks });

        // Advance the clock to trigger the interval
        await clock.tickAsync(1100); // Simulate 1.1 seconds passing

        // Wait for any pending promises to resolve
        await commandPromise;

        // Verify that createTerminal was called to start the dev server
        assert.ok(createTerminalStub.calledOnce);
        assert.strictEqual(createTerminalStub.firstCall.args[0], 'Shopify Dev');

        // Verify that the terminal was used to run the correct command
        assert.ok(sendTextStub.calledOnceWithExactly('npm run shopify app dev'));
        assert.ok(showStub.calledOnce);

        // Verify that openExternal was eventually called to open GraphiQL
        assert.ok(openExternalStub.calledOnce);

        // Ensure that fetch was called at least twice (initial failure and subsequent success)
        assert.ok(fetchCallCount >= 2);

        // Restore the clock
        clock.restore();
    });
});
