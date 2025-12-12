// Worker that processes array chunks
module.exports = async function(items) {
  return items.map(x => x * 2);
};

