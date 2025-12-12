// Worker that simulates slow work
module.exports = async function(ms) {
  await new Promise(resolve => setTimeout(resolve, ms));
  return `waited ${ms}ms`;
};

