import { request, gql } from 'graphql-request';
import { initializeApp } from 'firebase/app';
import { getFirestore, doc, getDoc } from 'firebase/firestore';
import { App } from '@slack/bolt';
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

interface AgentInfoResponse {
  agent: Array<{
    agentIndex: number;
    session: {
      gameFactory: string;
      gameSessionIndex: number;
    };
  }>;
}

// Slack command handlers
slackApp.command('/monitor', async ({ command, ack, respond }) => {
  await ack();
  
  const args = command.text.trim().split(' ');
  const action = args[0];
  
  if (action === 'add' && args[1]) {
    const sessionId = args[1];
    monitoredSessions.add(sessionId);
    await respond(`✅ Now monitoring session ${sessionId}. Currently monitoring: ${Array.from(monitoredSessions).join(', ')}`);
  } else if (action === 'remove' && args[1]) {
    const sessionId = args[1];
    monitoredSessions.delete(sessionId);
    await respond(`❌ Stopped monitoring session ${sessionId}. Currently monitoring: ${Array.from(monitoredSessions).join(', ')}`);
  } else if (action === 'list') {
    const sessions = Array.from(monitoredSessions);
    await respond(sessions.length > 0 ? `📋 Currently monitoring sessions: ${sessions.join(', ')}` : '📋 No sessions being monitored');
  } else if (action === 'clear') {
    monitoredSessions.clear();
    await respond('🗑️ Cleared all monitored sessions');
  } else {
    await respond(`Usage:
• \`/monitor add <session-id>\` - Add a session to monitor
• \`/monitor remove <session-id>\` - Remove a session from monitoring
• \`/monitor list\` - List all monitored sessions
• \`/monitor clear\` - Clear all monitored sessions`);
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

async function notifySlack(message: string) {
  if (!SLACK_WEBHOOK) {
    console.error('[Slack] SLACK_WEBHOOK is not set in environment variables.');
    return;
  }
  console.log(`[Slack] Sending notification: ${message}`);
  await fetch(SLACK_WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: message }),
  });
}

async function checkAgents() {
  try {
    if (monitoredSessions.size === 0) {
      console.log('[Heartbeat] No sessions being monitored. Use /monitor add <session-id> to start monitoring.');
      return;
    }

    const sessionIds = Array.from(monitoredSessions).map(id => parseInt(id));
    console.log(`[Heartbeat] Fetching agent info for sessions: ${sessionIds.join(', ')}`);
    
    const data = await request<AgentInfoResponse>(GRAPHQL_ENDPOINT, AGENT_INFO_QUERY, { sessionIds });
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
  // Start Slack app in Socket Mode
  (async () => {
    await slackApp.start();
    console.log('⚡️ Slack bot is running in Socket Mode!');
  })();

  // Start cron job
  cron.schedule('*/5 * * * *', checkAgents);
  console.log('Agent heartbeat service started. Use /monitor commands to control which sessions to monitor.');
}