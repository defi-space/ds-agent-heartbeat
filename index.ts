import { request, gql } from 'graphql-request';
import { initializeApp } from 'firebase/app';
import { getFirestore, doc, getDoc } from 'firebase/firestore';
import cron from 'node-cron';
import fetch from 'node-fetch';

const SLACK_WEBHOOK = process.env["SLACK_WEBHOOK"] || "";
const GRAPHQL_ENDPOINT = 'https://qip.systems/v1/graphql';

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

const AGENT_INFO_QUERY = gql`
  query AgentInfo {
    agent {
      id
      agentIndex
      sessionId
      session {
        gameFactory
      }
    }
  }
`;

async function getAgentThoughts(agentIndex: number, gameSessionId: string, gameFactory: string) {
  const collectionName = `f_${gameFactory.slice(-5)}_s_${gameSessionId}_a_${agentIndex}`;
  console.log(`[Firestore] Checking collection: ${collectionName}, doc: working-memory:cli:agent-${agentIndex}`);
  const docRef = doc(db, collectionName, `working-memory:cli:agent-${agentIndex}`);
  const docSnap = await getDoc(docRef);
  if (!docSnap.exists()) {
    console.warn(`[Firestore] No document found for agent-${agentIndex} in session ${gameSessionId}`);
    return undefined;
  }
  const data = docSnap.data();
  const workingMemory = data["value"];
  if (!workingMemory || !Array.isArray(workingMemory.thoughts)) {
    console.warn(`[Firestore] No thoughts array for agent-${agentIndex} in session ${gameSessionId}`);
    return undefined;
  }
  const latest = workingMemory.thoughts.sort((a: any, b: any) => b.timestamp - a.timestamp)[0];
  if (latest) {
    console.log(`[Firestore] Latest thought for agent-${agentIndex} in session ${gameSessionId}: timestamp ${latest.timestamp}`);
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
    console.log('[Heartbeat] Fetching agent info from GraphQL...');
    const data = await request(GRAPHQL_ENDPOINT, AGENT_INFO_QUERY);
    const agents = data.agent;
    console.log(`[Heartbeat] Found ${agents.length} agents.`);
    const now = Date.now();
    const downAgents: { agentId: number, sessionId: string }[] = [];
    for (const agent of agents) {
      console.log(`[Heartbeat] Checking agent-${agent.agentIndex} in session ${agent.sessionId}...`);
      const thought = await getAgentThoughts(agent.agentIndex, agent.sessionId, agent.session.gameFactory);
      if (!thought || !thought.timestamp) {
        console.warn(`[Heartbeat] No recent thought for agent-${agent.agentIndex} in session ${agent.sessionId}`);
        downAgents.push({ agentId: agent.agentIndex, sessionId: agent.sessionId });
      } else if (now - thought.timestamp > 10 * 60 * 1000) {
        console.warn(`[Heartbeat] Agent-${agent.agentIndex} in session ${agent.sessionId} is down (last update ${(now - thought.timestamp) / 60000} min ago)`);
        downAgents.push({ agentId: agent.agentIndex, sessionId: agent.sessionId });
      } else {
        console.log(`[Heartbeat] Agent-${agent.agentIndex} in session ${agent.sessionId} is healthy.`);
      }
    }
    if (downAgents.length > 0) {
      const msg = `<!channel> The following agents are down: \n` +
        downAgents.map(a => `agent-${a.agentId} on game session ${a.sessionId}`).join('\n');
      await notifySlack(msg);
    } else {
      console.log('[Heartbeat] All agents are healthy.');
    }
  } catch (err) {
    console.error('[Heartbeat] Error checking agents:', err);
  }
}

cron.schedule('*/5 * * * *', checkAgents);

console.log('Agent heartbeat service started.');