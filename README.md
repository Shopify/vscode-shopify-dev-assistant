# Shopify Dev Assistant

A VS Code extension that provides AI-powered assistance for developers building on the Shopify platform. This extension integrates directly with VS Code's chat interface to help you with Shopify development tasks and includes convenient features like direct GraphiQL integration.

## Features

### 🤖 AI Assistant
- Access Shopify-specific AI assistance directly within VS Code
- Get help with Shopify API queries, app development, and platform-specific questions
- Context-aware responses tailored to Shopify development

### 🔍 GraphiQL Integration
- Execute GraphQL queries directly from chat responses
- Automatically launches GraphiQL with your query when needed
- Seamlessly integrates with your local development environment

## Requirements

- VS Code 1.95.0 or higher
- Node.js and npm/pnpm installed
- A running Shopify app development environment

## Installation

1. Install the extension from the VS Code marketplace
2. Ensure you have the Shopify CLI installed and configured
3. Start using the assistant by opening VS Code's chat panel and typing `@shopify`

## Usage

1. Open VS Code's chat panel (Ctrl/Cmd + Shift + P > "Open Chat")
2. Type `@shopify` followed by your prompt
3. For GraphQL queries, click the "Open in GraphiQL" button to test them in GraphiQL

## Known Issues

- GraphiQL integration requires a running Shopify app development server
- The extension will attempt to start the development server if it's not running

## License

[MIT License](LICENSE)
