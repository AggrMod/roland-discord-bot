const solanaWeb3 = require('@solana/web3.js');
const fs = require('fs');

async function run() {
  const connection = new solanaWeb3.Connection('https://api.mainnet-beta.solana.com', {
    commitment: 'confirmed'
  });
  const pubkey = new solanaWeb3.PublicKey('8ZXH1ieZH9zHpzSXwLEof9pwY2iZRw4WDkskqzRpKBfM');

  let allSigs = [];
  let before = undefined;

  if (fs.existsSync('sigs.json')) {
    allSigs = JSON.parse(fs.readFileSync('sigs.json', 'utf8'));
    console.log('Loaded', allSigs.length, 'signatures from file.');
    if (allSigs.length > 0) {
      before = allSigs[allSigs.length - 1];
    }
  }

  console.log('Fetching signatures...');
  let sigsFailed = false;
  while (!sigsFailed) {
    try {
      const sigs = await connection.getSignaturesForAddress(pubkey, { limit: 1000, before });
      if (sigs.length === 0) break;
      const newSigs = sigs.map(s => s.signature);
      allSigs.push(...newSigs);
      before = sigs[sigs.length - 1].signature;
      console.log(`Fetched ${allSigs.length} signatures so far...`);
      fs.writeFileSync('sigs.json', JSON.stringify(allSigs, null, 2));
      await new Promise(r => setTimeout(r, 1000));
    } catch (err) {
      console.error('Error fetching sigs:', err.message);
      sigsFailed = true; // Just proceed with what we have
    }
  }

  console.log('Total signatures to process:', allSigs.length);

  const senders = new Set();
  const chunkSize = 5;
  
  let processed = 0;
  for (let i = 0; i < allSigs.length; i += chunkSize) {
    const chunk = allSigs.slice(i, i + chunkSize);
    let success = false;
    let retries = 0;
    while (!success) {
      try {
        const parsedTxs = await connection.getParsedTransactions(chunk, { maxSupportedTransactionVersion: 0 });

        for (const tx of parsedTxs) {
          if (!tx || !tx.meta) continue;

          const accountKeys = tx.transaction.message.accountKeys;
          const targetIndex = accountKeys.findIndex(k => k.pubkey.toBase58() === pubkey.toBase58());
          if (targetIndex === -1) continue;

          const preBal = tx.meta.preBalances[targetIndex];
          const postBal = tx.meta.postBalances[targetIndex];

          if (postBal > preBal) {
            const sender = accountKeys[0].pubkey.toBase58();
            senders.add(sender);
          }
        }
        success = true;
        processed += chunk.length;
        if (processed % 50 === 0 || processed === allSigs.length) {
          console.log(`Processed ${processed} / ${allSigs.length}`);
        }
        await new Promise(r => setTimeout(r, 500));
      } catch (err) {
        retries++;
        console.error('Error processing chunk starting at', i, err.message, 'Retrying in 5s...');
        if (retries > 3) {
          console.log('Skipping chunk after 3 retries');
          break;
        }
        await new Promise(r => setTimeout(r, 5000));
      }
    }
  }

  console.log('Total unique senders of SOL:', senders.size);
  console.log('Sample Senders:', Array.from(senders).slice(0, 20));
  fs.writeFileSync('senders.json', JSON.stringify(Array.from(senders), null, 2));
}

run().catch(console.error);
