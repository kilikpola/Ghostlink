import { createGMPNode } from '../dist/node-factory.js';
import readline from 'readline';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function askQuestion(query) {
  return new Promise(resolve => rl.question(query, resolve));
}

async function main() {
  console.log('============================================================');
  console.log('         GhostLink Custom Mesh Protocol (GMP)               ');
  console.log('              Public Peer Bootstrap Server                  ');
  console.log('============================================================\n');

  // Configure Port
  const customPort = await askQuestion('Enter port to listen on (Press Enter for default: 49500): ');
  const port = parseInt(customPort.trim(), 10) || 49500;

  // Configure Seed
  const customSeed = await askQuestion(`Enter identity seed (Press Enter for default: "public-peer-default-seed-on-port-${port}"): `);
  const seedPhrase = customSeed.trim() || `public-peer-default-seed-on-port-${port}`;

  // Start Node
  console.log('\nInitializing Public Peer Node...');
  const node = createGMPNode({
    port,
    isPublicPeer: true
  });

  await node.loadIdentity(seedPhrase);
  await node.listen();

  const nodeIdHex = Buffer.from(node.identity.nodeId).toString('hex');
  console.log('\n🚀 Public Peer is active and listening!');
  console.log(`NodeID (Hex): ${nodeIdHex}`);
  console.log(`Port:         ${port}`);
  console.log('\nAdd the following entry to other peers\' public-peers.json:');
  console.log(JSON.stringify({
    address: "<YOUR_VPS_PUBLIC_IP>",
    port: port,
    nodeId: nodeIdHex,
    addedAt: Date.now(),
    lastVerified: Date.now()
  }, null, 2));
  console.log('\n------------------------------------------------------------');
  console.log('Waiting for connections. Press Ctrl+C to terminate.');
  console.log('------------------------------------------------------------\n');

  // Monitor events
  node.on('connection', ({ connId, peerNodeId, type }) => {
    console.log(`[${new Date().toLocaleTimeString()}] Connection established: ID=${connId}, Type=${type}, Peer=${Buffer.from(peerNodeId).toString('hex').slice(0, 16)}...`);
  });

  node.on('message', ({ connId, msg }) => {
    // If we handle binding requests, it happens inside link.js and is processed automatically.
    // We can print standard messages here if any.
  });

  node.on('rate-limited', ({ ip, type }) => {
    console.log(`[${new Date().toLocaleTimeString()}] Rate limited connection from IP: ${ip} (Type: ${type})`);
  });

  node.on('close', ({ connId }) => {
    console.log(`[${new Date().toLocaleTimeString()}] Connection closed: ID=${connId}`);
  });

  node.on('error', ({ connId, err }) => {
    console.log(`[${new Date().toLocaleTimeString()}] Connection error on ${connId}: ${err.message}`);
  });
}

main().catch(err => {
  console.error('Bootstrap Public Peer server crashed:', err);
  rl.close();
});
