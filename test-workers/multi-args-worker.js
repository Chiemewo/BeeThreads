// Worker with multiple arguments
module.exports = async function(a, b, c) {
  return { sum: a + b + c, product: a * b * c };
};

