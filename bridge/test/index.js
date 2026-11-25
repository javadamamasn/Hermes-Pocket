'use strict';

// Node 24 resolves a directory passed to `node --test bridge/test` through
// index.js. Requiring the suites here makes that command run all of them;
// `node --test bridge/test/*.test.js` keeps working too.
require('./claude.test.js');
require('./pi.test.js');
require('./omp.test.js');
require('./dispatch.test.js');
require('./ws.test.js');
