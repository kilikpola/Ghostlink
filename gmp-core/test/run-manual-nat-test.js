import { createGMPNode } from '../dist/node-factory.js';
import { loadPublicPeers, queryPublicAddress, querySinglePeer } from '../dist/public-peer-list.js';
import { detectNATType } from '../dist/nat-detector.js';
import { holePunchConnect } from '../dist/hole-punch.js';
import readline from 'readline';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function askQuestion(query) {
  return new Promise(resolve => rl.question(query, resolve));
}

function encodePayload(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64');
}

function decodePayload(str) {
  try {
    return JSON.parse(Buffer.from(str.trim(), 'base64').toString('utf8'));
  } catch (e) {
    throw new Error('Invalid Base64 payload. Please make sure you copied the entire string.');
  }
}

async function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  console.log('============================================================');
  console.log('         GhostLink Custom Mesh Protocol (GMP)               ');
  console.log('         Phase 2b Manual NAT Test Helper                    ');
  console.log('============================================================\n');

  // Choose role
  console.log('Select your role for this test:');
  console.log(' 1. Initiator (starts the invite process and sets the timestamp)');
  console.log(' 2. Responder (scans/receives the invite and follows the timestamp)');
  const roleChoice = await askQuestion('Enter choice (1 or 2): ');
  const isInitiator = roleChoice.trim() === '1';
  const roleName = isInitiator ? 'Initiator' : 'Responder';

  console.log(`\nStarting as: ${roleName}`);

  // Setup seed phrase
  const defaultSeed = isInitiator 
    ? 'manual nat test default initiator seed phrase' 
    : 'manual nat test default responder seed phrase';
  const customSeed = await askQuestion(`Enter seed phrase (Press Enter for default: "${defaultSeed}"): `);
  const seedPhrase = customSeed.trim() || defaultSeed;

  // Port selection
  const defaultPort = isInitiator ? 49501 : 49502;
  const customPort = await askQuestion(`Enter local port to listen on (Press Enter for default: ${defaultPort}): `);
  const port = parseInt(customPort.trim(), 10) || defaultPort;

  // Initialize node
  console.log('\n[1/5] Initializing local GMP node...');
  const node = createGMPNode({ port });
  await node.loadIdentity(seedPhrase);
  await node.listen();
  console.log(`      Local NodeID: ${Buffer.from(node.identity.nodeId).toString('hex')}`);
  console.log(`      Listening on port ${port}`);

  // Query Public Peers
  console.log('\n[2/5] Performing address discovery & NAT classification...');
  const publicPeers = loadPublicPeers();
  console.log(`      Loaded ${publicPeers.length} public peers from public-peers.json.`);

  const bindingLogs = [];
  let discoveredAddress = null;
  let natType = 'UNKNOWN';
  let hasReachablePeer = false;

  if (publicPeers.length === 0) {
    console.warn('      [WARNING] No public peers loaded. Binding discovery and classification will be skipped.');
  } else {
    // Sequentially query to log individual peer responses
    for (const peer of publicPeers) {
      console.log(`      Querying peer ${peer.address}:${peer.port}...`);
      try {
        const res = await querySinglePeer(node, peer, 4000);
        console.log(`      -> Response: ${res.address}:${res.port}`);
        bindingLogs.push({ peer, success: true, response: res });
        hasReachablePeer = true;
      } catch (err) {
        console.warn(`      -> Failed: ${err.message}`);
        bindingLogs.push({ peer, success: false, error: err.message });
      }
    }

    if (hasReachablePeer) {
      try {
        discoveredAddress = await queryPublicAddress(node, publicPeers, 4000);
        console.log(`      Discovered Public IP/Port: ${discoveredAddress.address}:${discoveredAddress.port}`);
      } catch (err) {
        console.warn(`      Failed to determine consensus public address: ${err.message}`);
      }

      try {
        natType = await detectNATType(node, publicPeers, 4000);
        console.log(`      Discovered NAT Type: ${natType}`);
      } catch (err) {
        console.warn(`      Failed to classify NAT Type: ${err.message}`);
      }
    }
  }

  let isLocalLoopbackMode = false;
  if (!hasReachablePeer) {
    console.log('\n============================================================');
    console.log('⚠️  PRE-FLIGHT WARNING: NO CONFIGURED PUBLIC PEERS ARE REACHABLE!');
    console.log('============================================================');
    console.log('We tried contacting your public peers, but all attempts failed.');
    console.log('\nPlease verify:');
    console.log('1. Your Public Peer processes are running on your VPS/public machines.');
    console.log('   (Ensure they were started persistently, e.g. using tmux, screen, or nohup)');
    console.log('2. The addresses and ports in \'data/public-peers.json\' are correct.');
    console.log('3. Your firewalls allow connections on those ports.');
    console.log('============================================================\n');

    const useLocal = await askQuestion('Proceed with a LOCAL LOOPBACK (localhost-only) test instead? (y/n): ');
    if (useLocal.toLowerCase().trim() === 'y') {
      isLocalLoopbackMode = true;
      discoveredAddress = { address: '127.0.0.1', port };
      console.log('\n--> RUNNING IN LOCAL LOOPBACK MODE (Forced 127.0.0.1) <--\n');
    } else {
      console.log('Aborting test. Make sure public peers are reachable first.');
      node.close();
      rl.close();
      return;
    }
  } else {
    console.log('\n--> SUCCESS: Public peer(s) reachable. Proceeding with real test. <--\n');
  }

  // Setup logging state
  const logState = {
    timestamp: new Date().toISOString(),
    role: roleName,
    localNodeId: Buffer.from(node.identity.nodeId).toString('hex'),
    localPort: port,
    publicPeersQueried: bindingLogs,
    discoveredAddress,
    natType,
    isLocalLoopbackMode,
    peerNodeId: null,
    peerObservedAddress: null,
    coordinatedTimestamp: null,
    holePunchStartTime: null,
    retryCount: 0,
    outcome: 'PENDING',
    errorDetails: null,
    successfulLink: null
  };

  function writeTestLog() {
    try {
      const dataDir = path.join(__dirname, '..', 'data');
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }
      const logFilename = `manual-nat-test-${Date.now()}.log`;
      const logPath = path.join(dataDir, logFilename);
      fs.writeFileSync(logPath, JSON.stringify(logState, null, 2), 'utf-8');
      console.log(`\n[Log Helper] Test log successfully written to: ${logPath}`);
    } catch (e) {
      console.error('\n[Log Helper] Failed to write test log:', e.message);
    }
  }

  // Share and coordinate payloads
  let peerInfo = null;
  let targetTimestamp = null;

  if (isInitiator) {
    // ------------------------------------------------------------
    // INITIATOR FLOW (A):
    // 1. Generates and prints Payload A (Invite Payload).
    // 2. Prompts user to paste Payload B (Coordinated Response Payload from Responder).
    // ------------------------------------------------------------
    console.log('\n[3/5] Initiator: Generate invite payload');
    const initiatorPayload = {
      nodeId: logState.localNodeId,
      address: discoveredAddress.address,
      port: discoveredAddress.port,
      natType: natType
    };
    const b64Invite = encodePayload(initiatorPayload);
    console.log('------------------------------------------------------------');
    console.log('COPY AND SEND THIS INVITE PAYLOAD TO PEER B (RESPONDER):');
    console.log(b64Invite);
    console.log('------------------------------------------------------------\n');

    // Wait for Peer B's Coordinated Response payload (Payload B)
    const responderPayloadStr = await askQuestion('PASTE RESPONDER (PEER B) COORDINATED RESPONSE PAYLOAD HERE: ');
    try {
      peerInfo = decodePayload(responderPayloadStr);
      targetTimestamp = peerInfo.attemptTimestamp;
      if (!targetTimestamp) {
        throw new Error('Coordinated response payload did not contain attemptTimestamp.');
      }
      console.log(`\n      Successfully decoded Peer B Coordinated Response info:`);
      console.log(`      NodeID: ${peerInfo.nodeId}`);
      console.log(`      Observed Address: ${peerInfo.address}:${peerInfo.port}`);
      console.log(`      NAT Type: ${peerInfo.natType}`);
      console.log(`      Attempt Timestamp: ${targetTimestamp}`);

      if (targetTimestamp < Date.now()) {
        throw new Error(`Coordinated timestamp has already passed (expired by ${Date.now() - targetTimestamp}ms). Please run both scripts again.`);
      }
    } catch (e) {
      console.error('      Error decoding coordinated response payload:', e.message);
      logState.outcome = 'FAILED';
      logState.errorDetails = e.message;
      writeTestLog();
      node.close();
      rl.close();
      return;
    }

  } else {
    // ------------------------------------------------------------
    // RESPONDER FLOW (B):
    // 1. Prompts user to paste Payload A (Invite Payload from Initiator).
    // 2. Decodes Payload A, sets target attemptTimestamp (60s in future).
    // 3. Generates and prints Payload B (Coordinated Response Payload).
    // ------------------------------------------------------------
    console.log('\n[3/5] Responder: Paste Initiator Invite Payload');
    const invitePayloadStr = await askQuestion('PASTE INITIATOR (PEER A) INVITE PAYLOAD HERE: ');
    try {
      peerInfo = decodePayload(invitePayloadStr);
      console.log(`\n      Successfully decoded Peer A Invite info:`);
      console.log(`      NodeID: ${peerInfo.nodeId}`);
      console.log(`      Observed Address: ${peerInfo.address}:${peerInfo.port}`);
      console.log(`      NAT Type: ${peerInfo.natType}`);
    } catch (e) {
      console.error('      Error decoding invite payload:', e.message);
      logState.outcome = 'FAILED';
      logState.errorDetails = e.message;
      writeTestLog();
      node.close();
      rl.close();
      return;
    }

    // Set coordinated timestamp (60 seconds in the future)
    const countdownSeconds = 60;
    targetTimestamp = Date.now() + (countdownSeconds * 1000);
    console.log(`\n[4/5] Responder: Coordinated time set to ${countdownSeconds} seconds in the future.`);

    const responderPayload = {
      nodeId: logState.localNodeId,
      address: discoveredAddress.address,
      port: discoveredAddress.port,
      natType: natType,
      attemptTimestamp: targetTimestamp
    };
    const b64Coord = encodePayload(responderPayload);
    console.log('------------------------------------------------------------');
    console.log('COPY AND SEND THIS COORDINATED RESPONSE PAYLOAD TO PEER A (INITIATOR):');
    console.log(b64Coord);
    console.log('------------------------------------------------------------\n');
  }

  logState.peerNodeId = peerInfo.nodeId;
  logState.peerObservedAddress = { address: peerInfo.address, port: peerInfo.port };
  logState.coordinatedTimestamp = targetTimestamp;

  // Start Hole Punching
  console.log('\n[5/5] Executing Coordinated TCP Hole Punching...');
  logState.holePunchStartTime = new Date().toISOString();

  const maxRetries = 25;
  logState.retryCount = maxRetries;

  try {
    const result = await holePunchConnect({
      node,
      peerNodeId: peerInfo.nodeId,
      peerObservedAddress: { address: peerInfo.address, port: peerInfo.port },
      attemptTimestamp: targetTimestamp,
      timeoutMs: 8000, // 8 second timeout to account for delay
    });

    console.log('\n============================================================');
    console.log('🎉 SUCCESS: Direct connection established via hole punching!');
    console.log(`Peer Authenticated NodeID: ${Buffer.from(result.peerNodeId).toString('hex')}`);
    console.log('============================================================');

    logState.outcome = 'SUCCESS';
    logState.successfulLink = {
      connId: result.connId,
      peerNodeIdHex: Buffer.from(result.peerNodeId).toString('hex')
    };

    // Keep connection alive for 5 seconds to show it works, then exit
    console.log('\nKeeping connection open for 5 seconds to verify stability...');
    await delay(5000);
    result.link.destroy();

  } catch (err) {
    console.log('\n============================================================');
    console.log('✗ FAILED: Hole punching failed.');
    console.log(err.message);
    console.log('============================================================');

    logState.outcome = 'FAILED';
    logState.errorDetails = err.message;
  }

  // Write log file
  writeTestLog();

  node.close();
  rl.close();
}

main().catch(err => {
  console.error('Fatal crash in manual NAT test helper:', err);
  rl.close();
});
