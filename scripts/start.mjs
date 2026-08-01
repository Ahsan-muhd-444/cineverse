/**
 * Production entry point.
 *
 * `NODE_ENV=production node server.js` is POSIX-only shell syntax — on Windows
 * it fails outright, which means `npm start` cannot be used to reproduce a
 * production problem on a developer's machine. Setting the variable here keeps
 * one start command that works everywhere, with no cross-env dependency.
 *
 * An explicit NODE_ENV from the environment always wins, so a platform that
 * sets its own is never overridden.
 */

process.env.NODE_ENV = process.env.NODE_ENV || 'production';

await import('../server.js');
