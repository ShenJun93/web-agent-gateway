export {
  classifyStatus,
  collectReceipt,
  isDevelopmentCheckout,
  parseTunnelProfile,
  parseWrapper,
  runProductHealthCli,
  type Diagnostic,
  type ProductStatus,
} from '../src/product-health.js';

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProductHealthCli } from '../src/product-health.js';

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runProductHealthCli();
}
