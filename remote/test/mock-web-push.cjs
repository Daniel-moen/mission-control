// Test preload (node --require): replaces web-push's sendNotification in the
// relay process so push tests never touch a real push service.
//
// Each send prints one line `MOCK_PUSH {"endpoint":…,"payload":{…},"options":{…}}`
// to stdout for the test to read. An endpoint containing "/gone" rejects with
// a 410, like a push service reporting an expired subscription.

'use strict';

const webpush = require('web-push');

webpush.sendNotification = async (subscription, payload, options) => {
  if (subscription.endpoint.includes('/gone')) {
    const err = new Error('Received unexpected response code');
    err.statusCode = 410;
    throw err;
  }
  process.stdout.write(`MOCK_PUSH ${JSON.stringify({ endpoint: subscription.endpoint, payload: JSON.parse(payload), options })}\n`);
  return { statusCode: 201, body: '', headers: {} };
};
