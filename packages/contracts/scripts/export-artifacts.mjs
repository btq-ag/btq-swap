// Copies the compiled ABI + bytecode the backend needs (run `npx hardhat compile` first).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const outDir = join(root, '..', 'backend', 'src', 'chains', 'artifacts');
mkdirSync(outDir, { recursive: true });
const items = [
  ['HtlcERC20', 'artifacts/contracts/HTLCERC20/HtlcERC20.sol/HtlcERC20.json'],
  ['MockUSDT', 'artifacts/contracts/MockUSDT.sol/MockUSDT.json'],
];
for (const [name, rel] of items) {
  const a = JSON.parse(readFileSync(join(root, rel), 'utf8'));
  const out = { contractName: a.contractName, sourceName: a.sourceName, abi: a.abi, bytecode: a.bytecode };
  writeFileSync(join(outDir, `${name}.json`), JSON.stringify(out, null, 2) + '\n');
  console.log(`exported ${name} (${a.bytecode.length / 2 - 1} bytes)`);
}
