const crypto = require('crypto');

function uuid() {
  if (crypto.randomUUID) {
    return crypto.randomUUID();
  }

  return [
    crypto.randomBytes(4).toString('hex'),
    crypto.randomBytes(2).toString('hex'),
    '4' + crypto.randomBytes(2).toString('hex').slice(1),
    (8 + Math.floor(Math.random() * 4)).toString(16) + crypto.randomBytes(2).toString('hex').slice(1),
    crypto.randomBytes(6).toString('hex')
  ].join('-');
}

module.exports = { uuid };
