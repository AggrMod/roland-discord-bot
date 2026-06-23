// Fix C (audit L-1): mask wallet addresses and tx signatures in info-level
// logs so plaintext logs don't deanonymize the Discord-ID -> wallet linkage.
// Format matches treasuryService.maskAddress (first4...last4).

function maskAddress(address) {
  const value = String(address || '');
  if (!value || value.length < 8) return '****';
  return `${value.substring(0, 4)}...${value.substring(value.length - 4)}`;
}

// Signatures are long; keep a short identifiable prefix for log correlation.
function maskSignature(signature) {
  const value = String(signature || '');
  if (!value) return '****';
  if (value.length <= 12) return `${value.substring(0, 4)}…`;
  return `${value.substring(0, 8)}…${value.substring(value.length - 4)}`;
}

module.exports = { maskAddress, maskSignature };
