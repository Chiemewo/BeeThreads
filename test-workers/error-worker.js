// Worker that throws errors
module.exports = async function(shouldFail) {
  if (shouldFail) {
    throw new Error('Intentional worker error');
  }
  return 'success';
};

