import { configureTestEnv } from './support/env.js';

/** A database of its own, so the empty-database bootstrap rule can be tested. */
export const TEST_DATABASE = configureTestEnv();
