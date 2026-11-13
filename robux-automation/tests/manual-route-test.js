const assert = require('assert');
const { messengerUrl } = require('../src/services/manual-route');

// The Messenger link is handed to every buyer's browser, so anything that is
// not plainly our Messenger page has to come back as "not configured".

function withEnv(value, fn) {
  const previous = process.env.MESSENGER_URL;
  if (value === undefined) delete process.env.MESSENGER_URL;
  else process.env.MESSENGER_URL = value;
  try {
    fn();
  } finally {
    if (previous === undefined) delete process.env.MESSENGER_URL;
    else process.env.MESSENGER_URL = previous;
  }
}

withEnv(undefined, () => assert.equal(messengerUrl(), null));
withEnv('https://m.me/rbxmn', () => assert.equal(messengerUrl(), 'https://m.me/rbxmn'));
withEnv(' https://m.me/rbxmn/?ref=x ', () => assert.equal(messengerUrl(), 'https://m.me/rbxmn'));
withEnv('https://www.messenger.com/t/123', () => assert.equal(messengerUrl(), 'https://www.messenger.com/t/123'));
withEnv('http://m.me/rbxmn', () => assert.equal(messengerUrl(), null));
withEnv('https://m.me/', () => assert.equal(messengerUrl(), null));
withEnv('https://m.me.evil.example/rbxmn', () => assert.equal(messengerUrl(), null));
withEnv('javascript:alert(1)', () => assert.equal(messengerUrl(), null));

console.log('Manual route tests passed');
