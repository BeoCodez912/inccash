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
  const file = process.env.DATA_FILE || path.join(__dirname, 'data.json');
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}
function saveData(data) {
  const file = process.env.DATA_FILE || path.join(__dirname, 'data.json');
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
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
    if (curr.chainId !== chainId || prev.chainId !== chainId) return false;
    if (curr.prevHash !== prev.hash) return false;
    const recomputed = calculateHash(curr.index, curr.prevHash, curr.transactionHash, curr.nonce, curr.timestamp, curr.chainId, curr.blockId);
    if (recomputed !== curr.hash) return false;
    if (!curr.hash.startsWith('0'.repeat(Math.min(difficulty, curr.hash.length)))) return false;
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

    if (actual < expected / 2) difficulty++;
    else if (actual > expected * 2 && difficulty > 1) difficulty--;
  }
}

/* -------------------- initialize chain (3 genesis blocks) -------------------- */
if (!blockchain || blockchain.length === 0) {
  blockchain = [];
  const txIds = ['nynvg5vw3srg1g3k5qmqqe13x','9KWCWTX3D'];
  txIds.forEach((id,i)=>{
    const prevHash = i===0?'0':blockchain[i-1].hash;
    blockchain.push(mineBlock(i, prevHash, id, transactionRules[id]??0, difficulty));
  });
  const lastTxId = Object.keys(transactionRules).pop();
  const lastPrev = blockchain[blockchain.length-1].hash;
  blockchain.push(mineBlock(2, lastPrev, lastTxId, transactionRules[lastTxId]??0, difficulty));
  saveData({ balance, transactionRules, blockchain, Name, Hope, Friend, difficulty, chainId });
}

/* -------------------- express setup -------------------- */
app.use(bodyParser.json({ verify:(req,res,buf)=>req.rawBody=buf }));
app.use(express.static(path.join(__dirname,'public')));
app.get('/', (_req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));

/* -------------------- endpoints -------------------- */
app.get('/chain', (_req,res)=>{
  const head = blockchain[blockchain.length-1];
  res.json({ chainId, name:Name, hope:Hope, friend:Friend, length:blockchain.length, head:{index:head.index, hash:head.hash, blockId:head.blockId, timestamp:head.timestamp}, difficulty });
});
app.get('/state', (_req,res)=>res.json({ balance, transactionRules, blockchain, Name, Hope, Friend, difficulty, chainId }));
app.get('/blocks/:blockId',(req,res)=>{
  const block = blockchain.find(b=>b.blockId===req.params.blockId);
  if(!block) return res.status(404).json({error:'Block not found'});
  res.json(block);
});
app.get('/tx/:transactionId',(req,res)=>{
  const matches = blockchain.filter(b=>b.transactionId===req.params.transactionId);
  if(matches.length===0) return res.status(404).json({error:'No blocks for that transactionId'});
  res.json(matches);
});
app.get('/balance', (_req,res)=>res.json({ balance }));

/* -------------------- deposit endpoint -------------------- */
app.post('/deposit',(req,res)=>{
  const {transactionId,amount} = req.body||{};
  const amt = Number(amount);
  if(!transactionId||!Number.isFinite(amt)||amt<=0) return res.status(400).json({error:'Provide transactionId and a positive amount'});
  if(!isBlockchainValid(blockchain)) return res.status(500).json({error:'Blockchain invalid'});
  const prev = blockchain[blockchain.length-1];
  const block = mineBlock(blockchain.length, prev.hash, transactionId, amt, difficulty);
  blockchain.push(block);
  balance += amt;
  adjustDifficultyIfNeeded();
  saveData({ balance, transactionRules, blockchain, Name, Hope, Friend, difficulty, chainId });
  res.json({ ok:true, balance, block });
});

/* -------------------- webhook -------------------- */
function isValidSquareSignature(req){
  const sig = req.headers['x-square-signature'];
  if(!process.env.WEBHOOK_SIGNATURE_KEY) return false;
  const expected = crypto.createHmac('sha1',process.env.WEBHOOK_SIGNATURE_KEY).update(req.rawBody).digest('base64');
  return sig===expected;
}
app.post('/square-webhook',(req,res)=>{
  if(!isValidSquareSignature(req)) return res.status(401).send('Invalid signature');
  if(!isBlockchainValid(blockchain)) return res.status(500).send('Blockchain invalid');
  const event = req.body;
  if(event.type==='payment.created'){
    const paymentId = event.data.id;
    if(transactionRules[paymentId]){
      balance+=transactionRules[paymentId];
      const prev = blockchain[blockchain.length-1];
      const block = mineBlock(blockchain.length, prev.hash, paymentId, transactionRules[paymentId], difficulty);
      blockchain.push(block);
      adjustDifficultyIfNeeded();
      saveData({ balance, transactionRules, blockchain, Name, Hope, Friend, difficulty, chainId });
    }
  }
  res.status(200).send('OK');
});

/* -------------------- start server -------------------- */
app.listen(port, ()=>console.log(`✅ Webhook + PoW chain running at http://localhost:${port}`));
