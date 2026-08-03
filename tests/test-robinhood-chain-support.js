#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'guildpilot-robinhood-chain-'));
process.env.DATABASE_PATH = path.join(runDir, 'robinhood-chain.db');
process.env.DB_BACKUP_ENABLED = 'false';
process.env.DB_BACKUP_ON_STARTUP = 'false';
process.env.EVM_ROBINHOOD_RPC_URL = 'https://robinhood.example.invalid/rpc';

process.on('exit', () => {
  try { require('../database/db').close(); } catch (_error) {}
  try { fs.rmSync(runDir, { recursive: true, force: true }); } catch (_error) {}
});

const {
  getChain,
  getEvmRpcUrl,
  getExplorerUrl,
  listSupportedChains,
  normalizeChainId,
} = require('../utils/chainIdentity');

const chain = getChain('robinhood-chain');
assert.ok(chain, 'Robinhood Chain is registered');
assert.strictEqual(normalizeChainId('robinhood'), 'eip155:4663');
assert.strictEqual(chain.family, 'evm');
assert.strictEqual(chain.numericChainId, 4663);
assert.strictEqual(chain.hexChainId, '0x1237');
assert.strictEqual(chain.nativeSymbol, 'ETH');
assert.strictEqual(getEvmRpcUrl(chain.chainId), process.env.EVM_ROBINHOOD_RPC_URL);
assert.strictEqual(
  getExplorerUrl(chain.chainId, 'address', '0x0000000000000000000000000000000000000001'),
  'https://robinhoodchain.blockscout.com/address/0x0000000000000000000000000000000000000001'
);
assert.ok(listSupportedChains().some(entry => entry.chainId === 'eip155:4663'));

for (const commandPath of [
  '../commands/verification/verification',
  '../commands/wallettracker/walletTracker',
  '../commands/nfttracker/nftTracker',
  '../commands/tokentracker/tokenTracker',
]) {
  const serialized = JSON.stringify(require(commandPath).data.toJSON());
  assert.ok(serialized.includes('eip155:4663'), `${commandPath} exposes Robinhood Chain`);
}

const repoRoot = path.resolve(__dirname, '..');
const portalHtml = fs.readFileSync(path.join(repoRoot, 'web/public/portal.html'), 'utf8');
const portalJs = fs.readFileSync(path.join(repoRoot, 'web/public/portal.js'), 'utf8');
assert.ok(portalHtml.includes('<option value="eip155:4663">Robinhood Chain</option>'), 'wallet and tracker forms expose Robinhood Chain');
assert.ok(portalHtml.includes('<option value="eip155:4663">Robinhood Chain (ERC-20)</option>'), 'token tracker exposes Robinhood Chain');
assert.ok(portalJs.includes("'eip155:4663': 'Robinhood Chain'"), 'portal renders the Robinhood chain label');
assert.ok(portalJs.includes("method: 'wallet_addEthereumChain'"), 'portal can add Robinhood Chain to browser wallets');

console.log('Robinhood Chain support assertions passed');
