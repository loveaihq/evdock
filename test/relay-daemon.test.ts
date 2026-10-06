// The end-to-end relay scenarios against the Node relay (`evdock relay serve`).

import { join } from 'node:path';
import { startRelayServer } from '../src/relay/node.js';
import { relayScenarios } from './relay-scenarios.js';

relayScenarios((dir, key) => startRelayServer({ dbPath: join(dir, 'relay.db'), key, port: 0 }));
