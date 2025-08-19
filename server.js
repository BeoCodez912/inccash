import express from 'express';
import bodyParser from 'body-parser';
import crypto from 'crypto';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();
const app = express();
const port = process.env.PORT || 3000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* -------------------- persistence helpers -------------------- */
function loadData() {
  return JSON.parse(fs.readFileSync(process.env.DATA_FILE, 'utf-8'));
}
function saveData(data) {
  fs.writeFileSync(process.env.DATA_FILE, JSON.stringify(data, null, 2));
}

/* -------------------- load existing blockchain -------------------- */
let { balance, transactionRules, blockchain, Name, Hope, Friend, difficulty, chainId } = loadData();

/* -------------------- mining config -------------------- */
const TARGET_BLOCK_TIME_MS = 3000;
const DIFFICULTY_ADJUSTMENT_INTERVAL = 5;

/* -------------------- chain identity -------------------- */
function computeChainId(name, hope, friend) {
  const basis = `${name ?? ''}|${hope ?? ''}|${friend ?? ''}`;
  return crypto.createHash('sha256').update(basis).digest('hex');
}
if (!chainId || chainId.length === 0) chainId = computeChainId(Name, Hope, Friend);
if (!difficulty || difficulty < 1) difficulty = 4;

/* -------------------- blockchain primitives -------------------- */
function makeBlockId(index, transactionId, timestamp) {
  return crypto.createHash('sha256').update(`${index}:${transactionId}:${timestamp}`).digest('hex');
}
function calculateHash(index, prevHash, transactionHash, nonce, timestamp, chainIdLocal, blockIdSeed) {
  return crypto
    .createHash('sha256')
    .update(`${index}${prevHash}${transactionHash}${nonce}${timestamp}${chainIdLocal}${blockIdSeed}`)
    .digest('hex');
}
function mineBlock(index, prevHash, transactionId, amount, diff) {
  const timestamp = Date.now();
  const txData = { transactionId, amount };
  const transactionHash = crypto.createHash('sha256').update(JSON.stringify(txData)).digest('hex');
  const prefix = '0'.repeat(diff);
  const blockId = makeBlockId(index, transactionId, timestamp);

  console.log(`⛏ Mining block #${index} at difficulty ${diff}...`);

  let nonce = 0;
  let hash = '';
  const t0 = Date.now();
  do {
    nonce++;
    hash = calculateHash(index, prevHash, transactionHash, nonce, timestamp, chainId, blockId);
  } while (!hash.startsWith(prefix));
  const miningTimeMs = Date.now() - t0;

  console.log(`✅ Block #${index} mined in ${(miningTimeMs / 1000).toFixed(2)}s — ${hash.slice(0,16)}…`);

  return {
    chainId,
    blockId,
    index,
    prevHash,
    transactionHash,
    nonce,
    hash,
    timestamp,
    transactionId,
    amount,
    miningTimeMs
  };
}

function isBlockchainValid(chain) {
  if (!Array.isArray(chain) || chain.length === 0) return true;
  for (let i = 1; i < chain.length; i++) {
    const curr = chain[i];
    const prev = chain[i - 1];
    if (curr.chainId !== chainId || prev.chainId !== chainId) {
      console.error(`❌ Block ${i} chainId mismatch`);
      return false;
    }
    if (curr.prevHash !== prev.hash) {
      console.error(`❌ Block ${i} prevHash mismatch`);
      return false;
    }
    const recomputed = calculateHash(
      curr.index,
      curr.prevHash,
      curr.transactionHash,
      curr.nonce,
      curr.timestamp,
      curr.chainId,
      curr.blockId
    );
    if (recomputed !== curr.hash) {
      console.error(`❌ Block ${i} hash invalid`);
      return false;
    }
    if (!curr.hash.startsWith('0'.repeat(Math.min(difficulty, curr.hash.length)))) {
      console.error(`❌ Block ${i} fails PoW check`);
      return false;
    }
  }
  return true;
}

function adjustDifficultyIfNeeded() {
  const len = blockchain.length;
  if (len > 1 && len % DIFFICULTY_ADJUSTMENT_INTERVAL === 0) {
    const start = len - DIFFICULTY_ADJUSTMENT_INTERVAL;
    const end = len - 1;
    const actual = blockchain[end].timestamp - blockchain[start].timestamp;
    const expected = TARGET_BLOCK_TIME_MS * DIFFICULTY_ADJUSTMENT_INTERVAL;

    if (actual < expected / 2) {
      difficulty++;
      console.log(`⚡ Difficulty increased → ${difficulty}`);
    } else if (actual > expected * 2 && difficulty > 1) {
      difficulty--;
      console.log(`🐢 Difficulty decreased → ${difficulty}`);
    }
  }
}

/* -------------------- initialize chain (genesis) -------------------- */
if (!blockchain || blockchain.length === 0) {
  blockchain = [];

  // Genesis block = first transaction
  const firstTxId = "nynvg5vw3srg1g3k5qmqqe13x";
  const firstTxAmount = transactionRules[firstTxId] ?? 0;
  const genesis = mineBlock(0, '0', firstTxId, firstTxAmount, difficulty);
  blockchain.push(genesis);

  // Second block = second transaction
  const secondTxId = "9KWCWTX3D";
  const secondTxAmount = transactionRules[secondTxId] ?? 0;
  const secondBlock = mineBlock(1, genesis.hash, secondTxId, secondTxAmount, difficulty);
  blockchain.push(secondBlock);

  // Persist initial chain
  saveData({ balance, transactionRules, blockchain, Name, Hope, Friend, difficulty, chainId });
}

/* -------------------- express setup -------------------- */
app.use(bodyParser.json({
  verify: (req, res, buf) => { req.rawBody = buf; }
}));
app.use(express.static(path.join(__dirname, 'public')));

/* -------------------- endpoints -------------------- */
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/rules', (_req, res) => {
  res.json({ balance, transactionRules, blockchain, difficulty });
});

app.get('/chain', (_req, res) => {
  const head = blockchain[blockchain.length - 1];
  res.json({
    chainId,
    name: Name ?? null,
    hope: Hope ?? null,
    friend: Friend ?? null,
    length: blockchain.length,
    head: { index: head.index, hash: head.hash, blockId: head.blockId, timestamp: head.timestamp },
    difficulty
  });
});

app.get('/blocks/:blockId', (req, res) => {
  const block = blockchain.find(b => b.blockId === req.params.blockId);
  if (!block) return res.status(404).json({ error: 'Block not found' });
  res.json(block);
});

app.get('/tx/:transactionId', (req, res) => {
  const matches = blockchain.filter(b => b.transactionId === req.params.transactionId);
  if (matches.length === 0) return res.status(404).json({ error: 'No blocks for that transactionId' });
  res.json(matches);
});

/* -------------------- webhook security -------------------- */
function isValidSquareSignature(req) {
  const sig = req.headers['x-square-signature'];
  const expected = crypto
    .createHmac('sha1', process.env.WEBHOOK_SIGNATURE_KEY)
    .update(req.rawBody)
    .digest('base64');
  return sig === expected;
}

/* -------------------- webhook endpoint -------------------- */
app.post('/square-webhook', (req, res) => {
  if (!isValidSquareSignature(req)) return res.status(401).send('Invalid signature');

  if (!isBlockchainValid(blockchain)) {
    console.error('🚨 Chain invalid; rejecting new blocks.');
    return res.status(500).send('Blockchain invalid.');
  }

  const event = req.body;
  if (event.type === 'payment.created') {
    const paymentId = event.data.id;

    if (transactionRules[paymentId]) {
      balance += transactionRules[paymentId];

      const prev = blockchain[blockchain.length - 1];
      const block = mineBlock(blockchain.length, prev.hash, paymentId, transactionRules[paymentId], difficulty);
      blockchain.push(block);

      adjustDifficultyIfNeeded();

      saveData({ balance, transactionRules, blockchain, Name, Hope, Friend, difficulty, chainId });

      console.log(Name, Hope, Friend);
      console.log(`💰 Payment ${paymentId} matched. New balance $${balance.toFixed(2)}`);
      console.log(`🧱 Block #${block.index} id=${block.blockId} hash=${block.hash.slice(0,16)}…`);
    } else {
      console.log(`ℹ Payment received, no rule for ID: ${paymentId}`);
    }
  }

  res.status(200).send('OK');
});

/* -------------------- start server -------------------- */
app.listen(port, () => {
  console.log(`✅ Webhook + PoW chain running at http://localhost:${port}`);
});
