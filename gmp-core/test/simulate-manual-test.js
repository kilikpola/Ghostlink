import { createGMPNode } from '../dist/node-factory.js';
import { holePunchConnect } from '../dist/hole-punch.js';

async function main() {
  console.log('=== Starting Localhost Manual Test Simulation ===\n');

  // 1. Initialize both nodes
  console.log('[1/5] Initializing Node A (Initiator) and Node B (Responder)...');
  const nodeA = createGMPNode({ port: 49501 });
  const nodeB = createGMPNode({ port: 49502 });

  await nodeA.loadIdentity('simulation node A identity');
  await nodeB.loadIdentity('simulation node B identity');

  await nodeA.listen();
  await nodeB.listen();

  console.log(`      Node A NodeID: ${Buffer.from(nodeA.identity.nodeId).toString('hex').slice(0, 16)}... listening on port 49501`);
  console.log(`      Node B NodeID: ${Buffer.from(nodeB.identity.nodeId).toString('hex').slice(0, 16)}... listening on port 49502`);

  // 2. Perform mock address discovery (since no public peers are running, both force 127.0.0.1)
  console.log('\n[2/5] Mocking address discovery (forcing localhost)...');
  const addrA = { address: '127.0.0.1', port: 49501 };
  const addrB = { address: '127.0.0.1', port: 49502 };
  console.log(`      Node A observed address: ${addrA.address}:${addrA.port}`);
  console.log(`      Node B observed address: ${addrB.address}:${addrB.port}`);

  // 3. Coordinate payloads (Step-by-step exchange)
  console.log('\n[3/5] Simulating payload exchange...');
  
  // Node A (Initiator) invite payload
  const inviteA = {
    nodeId: Buffer.from(nodeA.identity.nodeId).toString('hex'),
    address: addrA.address,
    port: addrA.port,
    natType: 'UNKNOWN'
  };
  console.log('      Node A generated invite payload.');

  // Node B (Responder) payload response
  const responseB = {
    nodeId: Buffer.from(nodeB.identity.nodeId).toString('hex'),
    address: addrB.address,
    port: addrB.port,
    natType: 'UNKNOWN'
  };
  console.log('      Node B received Node A\'s invite and generated response payload.');

  // Node A (Initiator) coordinated timestamp payload
  const countdownSeconds = 3;
  const targetTimestamp = Date.now() + (countdownSeconds * 1000);
  const coordA = {
    nodeId: Buffer.from(nodeA.identity.nodeId).toString('hex'),
    address: addrA.address,
    port: addrA.port,
    natType: 'UNKNOWN',
    attemptTimestamp: targetTimestamp
  };
  console.log(`      Node A set coordinated timestamp for ${countdownSeconds}s in the future.`);
  console.log('      Node B received coordinated payload.');

  // 4. Executing hole punching
  console.log('\n[4/5] Starting Coordinated TCP Hole Punching...');
  
  const punchPromises = [
    // Node A hole punches to Node B
    holePunchConnect({
      node: nodeA,
      peerNodeId: inviteA.nodeId, // Simulating target identification
      peerObservedAddress: addrB,
      attemptTimestamp: targetTimestamp,
      timeoutMs: 5000
    }).then(res => {
      console.log('      Node A: Hole punch succeeded!');
      return res;
    }).catch(err => {
      console.error('      Node A: Hole punch failed:', err.message);
      throw err;
    }),

    // Node B hole punches to Node A
    holePunchConnect({
      node: nodeB,
      peerNodeId: responseB.nodeId,
      peerObservedAddress: addrA,
      attemptTimestamp: targetTimestamp,
      timeoutMs: 5000
    }).then(res => {
      console.log('      Node B: Hole punch succeeded!');
      return res;
    }).catch(err => {
      console.error('      Node B: Hole punch failed:', err.message);
      throw err;
    })
  ];

  try {
    const results = await Promise.all(punchPromises);
    console.log('\n============================================================');
    console.log('🎉 SUCCESS: Direct connection established via hole punching!');
    console.log(`      Node A link connId: ${results[0].connId}`);
    console.log(`      Node B link connId: ${results[1].connId}`);
    console.log('============================================================');
    
    // Clean up
    results[0].link.destroy();
    results[1].link.destroy();
  } catch (err) {
    console.log('\n============================================================');
    console.log('✗ FAILED: Connection simulation failed.');
    console.log('============================================================');
  }

  nodeA.close();
  nodeB.close();
}

main().catch(err => {
  console.error('Simulation crash:', err);
});
