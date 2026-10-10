/* Active regression gate for packet-detail wire-path consistency. */
'use strict';

process.env.PACKETS_TEST_NAME_FILTER = 'wire path:';
require('./test-packets.js');
