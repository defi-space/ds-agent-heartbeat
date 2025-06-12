# ds-agent-heartbeat

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run start
```

To run a single test check (without scheduling):

```bash
bun run start --test
```

## What this service does

- Every 5 minutes, checks all agents in all game sessions (from the indexer GraphQL endpoint).
- For each agent, checks the latest Firestore "thought" timestamp.
- If any agent has not updated in 10+ minutes, notifies <!channel> on Slack with detailed information including:
  - Agent ID and session information
  - How long each agent has been down
  - Agents grouped by session for better readability

## Slack Notification Format

When agents are down, the service sends a formatted Slack message like:

```
:: <!channel> → AGENT ALERT ::

[session-0]
⟲ [agent-1] :: no data available
⟲ [agent-2] :: down for 15 minutes

[session-1]
⟲ [agent-1] :: down for 30 minutes
⟲ [agent-3] :: down for 45 minutes
```

## Command Line Options

- `--test`: Run a single check and exit (useful for testing without starting the cron scheduler)

## Environment Variables

Copy the provided `.env.example` to `.env` and fill out the values:

```
FIREBASE_API_KEY=your_api_key
FIREBASE_AUTH_DOMAIN=your_auth_domain
FIREBASE_PROJECT_ID=your_project_id
FIREBASE_STORAGE_BUCKET=your_storage_bucket
FIREBASE_MESSAGING_SENDER_ID=your_messaging_sender_id
FIREBASE_APP_ID=your_app_id
FIREBASE_MEASUREMENT_ID=your_measurement_id
SLACK_WEBHOOK=your_slack_webhook_url
```
