import { request, gql } from 'graphql-request';
import { initializeApp } from 'firebase/app';
import { getFirestore, doc, getDoc } from 'firebase/firestore';
import { App, LogLevel } from '@slack/bolt';
import cron from 'node-cron';
import fetch from 'node-fetch';

const SLACK_WEBHOOK = process.env["SLACK_WEBHOOK"] || "";
const SLACK_BOT_TOKEN = process.env["SLACK_BOT_TOKEN"] || "";
const SLACK_APP_TOKEN = process.env["SLACK_APP_TOKEN"] || "";
const GRAPHQL_ENDPOINT = 'https://qip.systems/v1/graphql';

// Store monitored sessions
let monitoredSessions = new Set<string>();

const firebaseConfig = {
  apiKey: process.env["FIREBASE_API_KEY"] || "",
  authDomain: process.env["FIREBASE_AUTH_DOMAIN"] || "",
  projectId: process.env["FIREBASE_PROJECT_ID"] || "",
  storageBucket: process.env["FIREBASE_STORAGE_BUCKET"] || "",
  messagingSenderId: process.env["FIREBASE_MESSAGING_SENDER_ID"] || "",
  appId: process.env["FIREBASE_APP_ID"] || "",
  measurementId: process.env["FIREBASE_MEASUREMENT_ID"] || "",
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// Initialize Slack app with Socket Mode
const slackApp = new App({
  token: SLACK_BOT_TOKEN,
  appToken: SLACK_APP_TOKEN,
  socketMode: true,
  logLevel: LogLevel.INFO,
});

const AGENT_INFO_QUERY = gql`
  query AgentInfo($sessionIds: [Int!]!) {
    agent(where: {session: {gameSessionIndex: {_in: $sessionIds}}}) {
      agentIndex
      session {
        gameFactory
        gameSessionIndex
      }
    }
  }
`;

const GAME_SESSION_QUERY = gql`
  query GameSessions {
    gameSession {
      address
      gameSessionIndex
      gameOver
      gameSuspended
    }
  }
`;

interface AgentInfoResponse {
  agent: Array<{
    agentIndex: number;
    session: {
      gameFactory: string;
      gameSessionIndex: number;
    };
  }>;
}

interface GameSessionResponse {
  gameSession: Array<{
    address: string;
    gameSessionIndex: number;
    gameOver: boolean;
    gameSuspended: boolean;
  }>;
}

// Function to check if a game session index exists
async function validateGameSessionExists(sessionIndex: number): Promise<boolean> {
  try {
    const data = await request<GameSessionResponse>(GRAPHQL_ENDPOINT, GAME_SESSION_QUERY);
    const maxIndex = data.gameSession.length - 1;
    return sessionIndex >= 0 && sessionIndex <= maxIndex;
  } catch (error) {
    console.error('[Validation] Error checking game session existence:', error);
    return false;
  }
}

// Function to check game session status (over or suspended)
async function checkGameSessionStatus(sessionIndex: number): Promise<{ exists: boolean; gameOver: boolean; gameSuspended: boolean; }> {
  try {
    const data = await request<GameSessionResponse>(GRAPHQL_ENDPOINT, GAME_SESSION_QUERY);
    const session = data.gameSession.find(s => s.gameSessionIndex === sessionIndex);
    
    if (!session) {
      return { exists: false, gameOver: false, gameSuspended: false };
    }
    
    return {
      exists: true,
      gameOver: session.gameOver,
      gameSuspended: session.gameSuspended
    };
  } catch (error) {
    console.error('[GameSession] Error checking game session status:', error);
    return { exists: false, gameOver: false, gameSuspended: false };
  }
}

// Function to handle automatic session removal
async function removeSessionFromMonitoring(sessionId: string, reason: 'over' | 'suspended'): Promise<void> {
  if (!monitoredSessions.has(sessionId)) {
    return;
  }
  
  monitoredSessions.delete(sessionId);
  const remainingSessions = Array.from(monitoredSessions).sort((a, b) => parseInt(a) - parseInt(b));
  
  const statusText = reason === 'over' ? 'game over' : 'game suspended';
  const message = `*:: GAME SESSION ${reason.toUpperCase()} ::*\n\n⟲ [session-${sessionId}] :: ${statusText} - automatically removed from monitoring\n\n*currently monitoring:* ${remainingSessions.length > 0 ? remainingSessions.map(s => `[session-${s}]`).join(', ') : 'none'}`;
  
  console.log(`[GameSession] Session ${sessionId} is ${statusText}, removing from monitoring`);
  await notifySlack(message);
}

// Slack command handlers
slackApp.command('/monitor', async ({ command, ack, respond }) => {
  await ack();
  
  const args = command.text.trim().split(' ');
  const action = args[0];
  
  if (action === 'add' && args[1]) {
    const sessionId = args[1];
    const sessionIndex = parseInt(sessionId);
    
    if (isNaN(sessionIndex)) {
      await respond(`*:: INVALID SESSION ::*\n\n⟲ session id must be a number`);
      return;
    }
    
    if (monitoredSessions.has(sessionId)) {
      await respond(`*:: SESSION ALREADY MONITORED ::*\n\n⟲ [session-${sessionId}] :: already being monitored`);
      return;
    }
    
    // Check if the game session exists
    const sessionExists = await validateGameSessionExists(sessionIndex);
    if (!sessionExists) {
      await respond(`*:: SESSION NOT FOUND ::*\n\n⟲ [session-${sessionId}] :: does not exist in the indexer`);
      return;
    }
    
    monitoredSessions.add(sessionId);
    const sessions = Array.from(monitoredSessions).sort((a, b) => parseInt(a) - parseInt(b));
    await respond(`*:: SESSION ADDED ::*\n\n⟲ [session-${sessionId}] :: now monitoring\n\n*currently monitoring:* ${sessions.map(s => `[session-${s}]`).join(', ')}`);
  } else if (action === 'remove' && args[1]) {
    const sessionId = args[1];
    
    if (!monitoredSessions.has(sessionId)) {
      await respond(`*:: SESSION NOT MONITORED ::*\n\n⟲ [session-${sessionId}] :: not currently being monitored`);
      return;
    }
    
    monitoredSessions.delete(sessionId);
    const sessions = Array.from(monitoredSessions).sort((a, b) => parseInt(a) - parseInt(b));
    await respond(`*:: SESSION REMOVED ::*\n\n⟲ [session-${sessionId}] :: stopped monitoring\n\n*currently monitoring:* ${sessions.length > 0 ? sessions.map(s => `[session-${s}]`).join(', ') : 'none'}`);
  } else if (action === 'list') {
    const sessions = Array.from(monitoredSessions).sort((a, b) => parseInt(a) - parseInt(b));
    if (sessions.length > 0) {
      const sessionsList = sessions.map(s => `⟲ [session-${s}] :: monitoring active`).join('\n');
      await respond(`*:: MONITORED SESSIONS ::*\n\n${sessionsList}`);
    } else {
      await respond(`*:: MONITORED SESSIONS ::*\n\n⟲ no sessions currently monitored`);
    }
  } else if (action === 'clear') {
    monitoredSessions.clear();
    await respond('*:: SESSIONS CLEARED ::*\n\n⟲ all monitoring stopped');
  } else {
    await respond(`*:: MONITOR COMMANDS ::*\n\n⟲ \`/monitor add <session-id>\` :: add session to monitor\n⟲ \`/monitor remove <session-id>\` :: remove session from monitoring\n⟲ \`/monitor list\` :: show all monitored sessions\n⟲ \`/monitor clear\` :: clear all monitored sessions`);
  }
});

async function getAgentThoughts(agentIndex: number, gameSessionId: string, gameFactory: string) {
  const collectionName = `f_${gameFactory.slice(-5)}_s_${gameSessionId}_a_${agentIndex + 1}`;
  console.log(`[Firestore] Checking collection: ${collectionName}, doc: working-memory:cli:agent-${agentIndex + 1}`);
  const docRef = doc(db, collectionName, `working-memory:cli:agent-${agentIndex + 1}`);
  const docSnap = await getDoc(docRef);
  if (!docSnap.exists()) {
    console.warn(`[Firestore] No document found for agent-${agentIndex + 1} in session ${gameSessionId}`);
    return undefined;
  }
  const data = docSnap.data();
  const workingMemory = data["value"];
  if (!workingMemory || !Array.isArray(workingMemory.thoughts)) {
    console.warn(`[Firestore] No thoughts array for agent-${agentIndex + 1} in session ${gameSessionId}`);
    return undefined;
  }
  const latest = workingMemory.thoughts.sort((a: any, b: any) => b.timestamp - a.timestamp)[0];
  if (latest) {
    console.log(`[Firestore] Latest thought for agent-${agentIndex + 1} in session ${gameSessionId}: timestamp ${latest.timestamp}`);
  }
  return latest;
}

// Track last notification time to prevent webhook rate limiting
let lastNotificationTime = 0;
const NOTIFICATION_COOLDOWN = 60000; // 1 minute cooldown between notifications

async function notifySlack(message: string) {
  if (!SLACK_WEBHOOK) {
    console.error('[Slack] SLACK_WEBHOOK is not set in environment variables.');
    return;
  }

  // Check cooldown to prevent webhook rate limiting
  const now = Date.now();
  if (now - lastNotificationTime < NOTIFICATION_COOLDOWN) {
    console.log(`[Slack] Notification skipped - cooldown active (${Math.ceil((NOTIFICATION_COOLDOWN - (now - lastNotificationTime)) / 1000)}s remaining)`);
    return;
  }

  try {
    console.log(`[Slack] Sending notification: ${message}`);
    const response = await fetch(SLACK_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: message }),
    });

    if (!response.ok) {
      console.error(`[Slack] Webhook failed with status ${response.status}: ${response.statusText}`);
      return;
    }

    lastNotificationTime = now;
    console.log('[Slack] Notification sent successfully');
  } catch (error) {
    console.error('[Slack] Error sending webhook notification:', error);
  }
}

async function checkAgents() {
  try {
    if (monitoredSessions.size === 0) {
      console.log('[Heartbeat] No sessions being monitored. Use /monitor add <session-id> to start monitoring.');
      return;
    }

    const sessionIds = Array.from(monitoredSessions).map(id => parseInt(id));
    console.log(`[Heartbeat] Fetching agent info for sessions: ${sessionIds.join(', ')}`);
    
    // First, check game session statuses for all monitored sessions
    const sessionsToRemove: string[] = [];
    for (const sessionId of monitoredSessions) {
      const sessionIndex = parseInt(sessionId);
      const status = await checkGameSessionStatus(sessionIndex);
      
      if (!status.exists) {
        console.log(`[GameSession] Session ${sessionId} no longer exists, removing from monitoring`);
        sessionsToRemove.push(sessionId);
      } else if (status.gameOver) {
        console.log(`[GameSession] Session ${sessionId} is over, removing from monitoring`);
        await removeSessionFromMonitoring(sessionId, 'over');
      } else if (status.gameSuspended) {
        console.log(`[GameSession] Session ${sessionId} is suspended, removing from monitoring`);
        await removeSessionFromMonitoring(sessionId, 'suspended');
      }
    }
    
    // Remove sessions that no longer exist (without notification since they're gone)
    for (const sessionId of sessionsToRemove) {
      monitoredSessions.delete(sessionId);
    }
    
    // If all sessions were removed, exit early
    if (monitoredSessions.size === 0) {
      console.log('[Heartbeat] No active sessions remain to monitor.');
      return;
    }
    
    // Continue with agent checking for remaining active sessions
    const remainingSessionIds = Array.from(monitoredSessions).map(id => parseInt(id));
    console.log(`[Heartbeat] Checking agents for active sessions: ${remainingSessionIds.join(', ')}`);
    
    const data = await request<AgentInfoResponse>(GRAPHQL_ENDPOINT, AGENT_INFO_QUERY, { sessionIds: remainingSessionIds });
    const agents = data.agent;
    console.log(`[Heartbeat] Found ${agents.length} agents in monitored sessions.`);
    
    const now = Date.now();
    const downAgents: { agentId: number, sessionId: string, downtime: number }[] = [];
    
    for (const agent of agents) {
      console.log(`[Heartbeat] Checking agent-${agent.agentIndex} in session ${agent.session.gameSessionIndex}...`);
      const thought = await getAgentThoughts(agent.agentIndex, agent.session.gameSessionIndex.toString(), agent.session.gameFactory);
      if (!thought || !thought.timestamp) {
        console.warn(`[Heartbeat] No recent thought for agent-${agent.agentIndex} in session ${agent.session.gameSessionIndex}`);
        downAgents.push({ agentId: agent.agentIndex, sessionId: agent.session.gameSessionIndex.toString(), downtime: -1 });
      } else if (now - thought.timestamp > 10 * 60 * 1000) {
        const downtime = Math.floor((now - thought.timestamp) / 60000);
        console.warn(`[Heartbeat] Agent-${agent.agentIndex} in session ${agent.session.gameSessionIndex} is down (last update ${downtime} min ago)`);
        downAgents.push({ agentId: agent.agentIndex, sessionId: agent.session.gameSessionIndex.toString(), downtime });
      } else {
        console.log(`[Heartbeat] Agent-${agent.agentIndex} in session ${agent.session.gameSessionIndex} is healthy.`);
      }
    }
    
    if (downAgents.length > 0) {
      // Group agents by session
      type AgentGroup = { agentId: number; sessionId: string; downtime: number }[];
      const agentsBySession = downAgents.reduce<Record<string, AgentGroup>>((acc, agent) => {
        const sessionId = agent.sessionId;
        acc[sessionId] = acc[sessionId] || [];
        acc[sessionId].push(agent);
        return acc;
      }, {});

      const msg = `*:: <!channel> → AGENT ALERT ::*\n\n` +
        Object.entries(agentsBySession)
          .sort(([sessionA], [sessionB]) => parseInt(sessionA) - parseInt(sessionB))
          .map(([sessionId, agents]) => {
            const sessionHeader = `*[session-${sessionId}]*`;
            const agentsList = agents
              .sort((a, b) => a.agentId - b.agentId)
              .map(a => `⟲ [agent-${a.agentId + 1}]${a.downtime === -1 ? ' :: no data available' : ` :: down for ${a.downtime} minutes`}`)
              .join('\n');
            return `${sessionHeader}\n${agentsList}`;
          })
          .join('\n\n');
      await notifySlack(msg);
    } else {
      console.log('[Heartbeat] All monitored agents are healthy.');
    }
  } catch (err) {
    console.error('[Heartbeat] Error checking agents:', err);
  }
}

const isTestMode = process.argv.includes('--test');

if (isTestMode) {
  console.log('Running in test mode - executing single check...');
  checkAgents().then(() => {
    console.log('Test check completed.');
    process.exit(0);
  });
} else {
  // Start Slack app in Socket Mode with retry logic
  (async () => {
    let retryCount = 0;
    const maxRetries = 3;
    const baseDelay = 5000; // 5 seconds base delay
    
    while (retryCount < maxRetries) {
      try {
        console.log(`[Slack] Starting Socket Mode connection (attempt ${retryCount + 1}/${maxRetries})...`);
        await slackApp.start();
        console.log('⚡️ Slack bot is running in Socket Mode!');
        break;
      } catch (error) {
        retryCount++;
        console.error(`[Slack] Failed to start Socket Mode (attempt ${retryCount}/${maxRetries}):`, error);
        
        if (retryCount < maxRetries) {
          // Exponential backoff: 5s, 10s, 20s
          const delay = baseDelay * Math.pow(2, retryCount - 1);
          console.log(`[Slack] Retrying in ${delay/1000} seconds...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        } else {
          console.error('[Slack] Failed to start after maximum retries. Exiting...');
          process.exit(1);
        }
      }
    }
  })();

  // Start cron job
  cron.schedule('*/5 * * * *', checkAgents);
  console.log('Agent heartbeat service started. Use /monitor commands to control which sessions to monitor.');
}

// Add error handling for Socket Mode
slackApp.error(async (error) => {
  console.error('[Slack] Error occurred:', error);
  
  // Handle rate limiting specifically
  if (error.code === 'slack_webapi_rate_limited') {
    console.log('[Slack] Rate limited - backing off...');
    // The SDK will handle the retry automatically with the retry-after header
    return;
  }
  
  // Handle connection errors gracefully
  if (error.message?.includes('connection') || 
      error.message?.includes('socket') ||
      error.message?.includes('server explicit disconnect') ||
      error.message?.includes('Unhandled event')) {
    console.log('[Slack] Connection/Socket error - SDK will handle reconnection');
    return;
  }
  
  // Log other errors but don't crash
  console.error('[Slack] Unhandled error:', error);
});

// Add process handlers for graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n[Process] Received SIGINT, gracefully shutting down...');
  try {
    await slackApp.stop();
    console.log('[Slack] Socket Mode connection closed');
  } catch (error) {
    console.error('[Slack] Error during shutdown:', error);
  }
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n[Process] Received SIGTERM, gracefully shutting down...');
  try {
    await slackApp.stop();
    console.log('[Slack] Socket Mode connection closed');
  } catch (error) {
    console.error('[Slack] Error during shutdown:', error);
  }
  process.exit(0);
});