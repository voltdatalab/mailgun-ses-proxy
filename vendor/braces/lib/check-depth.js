'use strict';

// Bound recursive AST walkers, including directly supplied ASTs.
module.exports = depth => {
  if (depth > 128) {
    throw new RangeError('Brace nesting exceeds maximum depth of 128');
  }
};
