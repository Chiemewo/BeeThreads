// Worker with require() access
const crypto = require('crypto');

module.exports = async function(numbers) {
  const hash = crypto.createHash('md5');
  hash.update(JSON.stringify(numbers));
  
  return {
    sum: numbers.reduce((a, b) => a + b, 0),
    avg: numbers.reduce((a, b) => a + b, 0) / numbers.length,
    hash: hash.digest('hex').slice(0, 8)
  };
};
