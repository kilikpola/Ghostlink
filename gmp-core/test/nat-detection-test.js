import './helpers/isolate-data.mjs'; // must stay first: keeps state out of gmp-core/data
import { classifyNAT, detectNATType } from '../dist/nat-detector.js';
import { EventEmitter } from 'events';

let testsRun = 0;
let testsPassed = 0;
let testsFailed = 0;

function assertEqual(actual, expected, message) {
  testsRun++;
  if (actual === expected) {
    testsPassed++;
    console.log(`  ✓ ${message}`);
  } else {
    testsFailed++;
    console.error(`  ✗ ${message} (expected ${expected}, got ${actual})`);
  }
}

function testClassificationLogic() {
  console.log('\n=== Test 1: NAT Heuristic Classification Logic ===');

  // Case 1: Port mismatch to the same peer (Q1 !== Q2) -> SYMMETRIC
  const q1_sym = { address: '198.51.100.1', port: 10001 };
  const q2_sym = { address: '198.51.100.1', port: 10002 };
  const q3_sym = { address: '198.51.100.1', port: 10003 };
  assertEqual(
    classifyNAT(q1_sym, q2_sym, q3_sym),
    'SYMMETRIC',
    'Classified different ports to same peer as SYMMETRIC'
  );

  // Case 2: Stable port to same peer, and same port to different peer -> NO_NAT_OR_FULL_CONE
  const q1_cone = { address: '198.51.100.1', port: 20000 };
  const q2_cone = { address: '198.51.100.1', port: 20000 };
  const q3_cone = { address: '198.51.100.1', port: 20000 };
  assertEqual(
    classifyNAT(q1_cone, q2_cone, q3_cone),
    'NO_NAT_OR_FULL_CONE',
    'Classified same port everywhere as NO_NAT_OR_FULL_CONE'
  );

  // Case 3: Stable port to same peer, but different port to different peer -> RESTRICTED_CONE
  const q1_rest = { address: '198.51.100.1', port: 20000 };
  const q2_rest = { address: '198.51.100.1', port: 20000 };
  const q3_rest = { address: '198.51.100.1', port: 20001 };
  assertEqual(
    classifyNAT(q1_rest, q2_rest, q3_rest),
    'RESTRICTED_CONE',
    'Classified different port to different peer as RESTRICTED_CONE'
  );

  // Case 4: IP mismatch across queries -> UNKNOWN or SYMMETRIC (if ports change)
  const q1_ip_mismatch = { address: '198.51.100.1', port: 20000 };
  const q2_ip_mismatch = { address: '198.51.100.1', port: 20000 };
  const q3_ip_mismatch = { address: '198.51.100.2', port: 20000 };
  assertEqual(
    classifyNAT(q1_ip_mismatch, q2_ip_mismatch, q3_ip_mismatch),
    'UNKNOWN',
    'Classified IP mismatch as UNKNOWN when ports are stable'
  );

  // Case 5: Empty inputs -> UNKNOWN
  assertEqual(
    classifyNAT(null, null, null),
    'UNKNOWN',
    'Classified null inputs as UNKNOWN'
  );
}

async function testDetectorEndToEnd() {
  console.log('\n=== Test 2: detectNATType with Mocked Node and Peers ===');

  const publicPeers = [
    { address: '8.8.8.8', port: 49500 },
    { address: '8.8.4.4', port: 49500 }
  ];

  // Helper to run detection with a sequence of mock responses
  async function runMockedDetection(responses) {
    const mockResponses = [...responses];
    const mockNode = {
      dial: async (address, port) => {
        const mockLink = new EventEmitter();
        mockLink.sendBindingRequest = () => {
          setTimeout(() => {
            const res = mockResponses.shift();
            if (res instanceof Error) {
              mockLink.emit('error', res);
            } else {
              mockLink.emit('binding-response', res);
            }
          }, 10);
        };
        mockLink.destroy = () => {};
        return { connId: 'mock-conn', link: mockLink };
      }
    };

    return detectNATType(mockNode, publicPeers, 1000);
  }

  // 1. Test Symmetric classification via detector
  const symResponses = [
    { address: '1.2.3.4', port: 1000 }, // Q1
    { address: '1.2.3.4', port: 2000 }, // Q2
    { address: '1.2.3.4', port: 3000 }  // Q3
  ];
  const typeSym = await runMockedDetection(symResponses);
  assertEqual(typeSym, 'SYMMETRIC', 'detectNATType returned SYMMETRIC for dynamic port mapping');

  // 2. Test Full-Cone classification via detector
  const coneResponses = [
    { address: '1.2.3.4', port: 1000 }, // Q1
    { address: '1.2.3.4', port: 1000 }, // Q2
    { address: '1.2.3.4', port: 1000 }  // Q3
  ];
  const typeCone = await runMockedDetection(coneResponses);
  assertEqual(typeCone, 'NO_NAT_OR_FULL_CONE', 'detectNATType returned NO_NAT_OR_FULL_CONE');

  // 3. Test Restricted-Cone classification via detector
  const restResponses = [
    { address: '1.2.3.4', port: 1000 }, // Q1
    { address: '1.2.3.4', port: 1000 }, // Q2
    { address: '1.2.3.4', port: 2000 }  // Q3
  ];
  const typeRest = await runMockedDetection(restResponses);
  assertEqual(typeRest, 'RESTRICTED_CONE', 'detectNATType returned RESTRICTED_CONE');

  // 4. Test error handling during detection
  const errResponses = [
    new Error('Connection failed'),
    { address: '1.2.3.4', port: 1000 },
    { address: '1.2.3.4', port: 1000 }
  ];
  const typeErr = await runMockedDetection(errResponses);
  assertEqual(typeErr, 'UNKNOWN', 'detectNATType returned UNKNOWN on query failure');
}

async function runTests() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║  GMP Phase 2b-ii — NAT Detection and Classification Tests  ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log('NOTE: This tests classification logic using synthetic data.  ');
  console.log('Real-world accuracy is only verifiable via a manual network test.');

  try {
    testClassificationLogic();
    await testDetectorEndToEnd();

    console.log('\n╔════════════════════════════════════════════════════════════╗');
    console.log(`║  Results: ${testsPassed} passed, ${testsFailed} failed, ${testsRun} total       ║`);
    console.log('╚════════════════════════════════════════════════════════════╝');

  } catch (err) {
    console.error('\nTest suite error:', err);
    console.error(err.stack);
    // Count the throw as a failure. Without this a suite that crashed
    // mid-run still exited 0, so a broken API read as a pass.
    testsFailed++;
  }

  process.exit(testsFailed > 0 ? 1 : 0);
}

runTests();
