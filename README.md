# ds-agent-heartbeat

Interactive Slack bot for monitoring specific game session agents using Socket Mode with built-in validation.

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

- Provides interactive Slack commands to control which sessions to monitor
- Every 5 minutes, checks agents only in the sessions you've specified
- For each agent in monitored sessions, checks the latest Firestore "thought" timestamp
- If any agent has not updated in 10+ minutes, notifies <!channel> on Slack with detailed information including:
  - Agent ID and session information
  - How long each agent has been down
  - Agents grouped by session for better readability

## Slack Commands

Use these commands in your Slack channel:

- `/monitor add <session-id>` - Add a session to monitor (validates existence first)
- `/monitor remove <session-id>` - Remove a session from monitoring  
- `/monitor list` - List all currently monitored sessions
- `/monitor clear` - Clear all monitored sessions

### Examples:
```
/monitor add 123
/monitor add 456
/monitor list
/monitor remove 123
/monitor clear
```
## Command Line Options

- `--test`: Run a single check and exit (useful for testing without starting the cron scheduler)

## Environment Variables

Copy the provided `.env.example` to `.env` and fill out the values:

```
# Firebase Configuration
FIREBASE_API_KEY=your_api_key
FIREBASE_AUTH_DOMAIN=your_auth_domain
FIREBASE_PROJECT_ID=your_project_id
FIREBASE_STORAGE_BUCKET=your_storage_bucket
FIREBASE_MESSAGING_SENDER_ID=your_messaging_sender_id
FIREBASE_APP_ID=your_app_id
FIREBASE_MEASUREMENT_ID=your_measurement_id

# Slack Configuration (Socket Mode)
SLACK_WEBHOOK=your_slack_webhook_url
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_APP_TOKEN=xapp-your-app-level-token
```