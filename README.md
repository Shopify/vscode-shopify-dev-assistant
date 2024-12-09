# Shopify Dev Assistant

This extension provides Al-powered assistance for developers building with GraphQL on the Shopify platform. This extension integrates directly with VS Code's chat interface to help you with Shopify development tasks, generate GraphQL Admin API operations, and launch our GraphiQL integration.

## Features

### 🤖 AI Assistant
- Access Shopify-specific AI assistance directly within VS Code
- Get help with Shopify API queries, app development, and platform-specific questions
- Receive context-aware responses tailored to Shopify development

### 🔍 GraphiQL integration
- Executes GraphQL queries directly from chat responses
- Launches GraphiQL automatically when needed
- Integrates seamlessly with your local development environment

#### Requirements

- GraphiQL integration requires a Shopify app that's created with [Shopify CLI](https://shopify.dev/docs/api/shopify-cli).
- Your dev server must be running. The extension will automatically attempt to start it if it's not running.

## Installation

1. Install the extension from the [VS Code marketplace](https://marketplace.visualstudio.com/items?itemName=Shopify.vscode-shopify-dev-assistant).
2. (Optional) Ensure that you have Shopify CLI [installed and configured](https://shopify.dev/docs/api/shopify-cli).

## Usage

1. Open VS Code's chat panel (Ctrl/Cmd + Shift + P > "Open Chat").
2. Type `@shopify`, followed by your prompt.
3. (Optional) Click the **Open in GraphiQL** button to test your queries.

## License

[MIT License](LICENSE)
