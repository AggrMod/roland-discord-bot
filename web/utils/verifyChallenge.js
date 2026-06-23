// Fix H (audit H-4, M-5): wallet-verification challenge binding helpers,
// extracted so the security-relevant logic is unit-testable.

const CHALLENGE_TTL_MS = 5 * 60 * 1000;

// Bind the signed message to the user AND a specific wallet so a captured
// signature cannot be replayed across users or swapped to a different wallet.
// Old clients that don't send a wallet get the legacy (unbound) message.
function buildChallengeMessage({ brandName, discordId, walletAddress, username, nonce, issuedAt }) {
  const wallet = String(walletAddress || '').trim();
  if (wallet) {
    return `${brandName} Wallet Verification\nDiscord ID: ${discordId}\nWallet: ${wallet}\nNonce: ${nonce}\nIssued: ${issuedAt}`;
  }
  return `${brandName} Wallet Verification\nUser: ${username}\nNonce: ${nonce}`;
}

// Returns an error string if the challenge is missing/expired or the submitted
// wallet does not match the wallet the challenge was bound to; null if ok.
function challengeError(challenge, walletAddress, now = Date.now(), ttlMs = CHALLENGE_TTL_MS) {
  if (!challenge || (now - challenge.createdAt) > ttlMs) {
    return 'Challenge expired. Please try again.';
  }
  if (challenge.walletAddress) {
    const bound = String(challenge.walletAddress).trim();
    if (bound && bound !== String(walletAddress || '').trim()) {
      return 'Wallet does not match the verification challenge. Please restart verification.';
    }
  }
  return null;
}

module.exports = { CHALLENGE_TTL_MS, buildChallengeMessage, challengeError };
