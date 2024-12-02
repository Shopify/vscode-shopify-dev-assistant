import * as assert from 'assert';
import * as vscode from 'vscode';
import { extractMarkdownUrls, extractCodeBlocks, handler } from '../extension';

suite('Extension Test Suite', () => {
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

suite('Chat Integration Tests', () => {
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
});
