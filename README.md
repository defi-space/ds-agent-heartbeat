# ds-agent-heartbeat

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run start
```

## What this service does

- Every 5 minutes, checks all agents in all game sessions (from the indexer GraphQL endpoint).
- For each agent, checks the latest Firestore "thought" timestamp.
- If any agent has not updated in 10+ minutes, notifies <!channel> on Slack with the agent and session info.

## Environment Variables

Create a `.env` file in the root with the following keys:

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
