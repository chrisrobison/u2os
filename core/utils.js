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

function isUuid(value) {
  if (typeof value !== 'string') return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.trim());
}

module.exports = { uuid, isUuid };
