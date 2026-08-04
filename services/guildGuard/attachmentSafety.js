const path = require('path');
const { safeRemoteFetch } = require('../../utils/safeRemoteFetch');

const EXECUTABLE_EXTENSIONS = new Set([
  '.apk', '.app', '.bat', '.cmd', '.com', '.cpl', '.deb', '.dll', '.dmg', '.exe', '.hta',
  '.img', '.iso', '.jar', '.js', '.jse', '.lnk', '.msi', '.msp', '.pif', '.pkg', '.ps1',
  '.reg', '.rpm', '.scr', '.vbe', '.vbs', '.wsf'
]);
const ACTIVE_CONTENT_EXTENSIONS = new Set(['.html', '.htm', '.mhtml', '.shtml', '.svg', '.xml']);
const ARCHIVE_EXTENSIONS = new Set(['.7z', '.ace', '.bz2', '.gz', '.rar', '.tar', '.tgz', '.xz', '.zip']);
const IMAGE_EXTENSIONS = new Set(['.gif', '.jpeg', '.jpg', '.png', '.webp']);
const IMAGE_CONTENT_TYPES = new Set(['image/gif', 'image/jpeg', 'image/png', 'image/webp']);
const DISCORD_ATTACHMENT_HOSTS = new Set(['cdn.discordapp.com', 'media.discordapp.net']);
const MAX_CONCURRENT_QR_SCANS = 3;
let activeQrScans = 0;

function extensionOf(filename) {
  return path.extname(String(filename || '').trim().toLowerCase());
}

function isDiscordAttachmentUrl(value) {
  try {
    const host = new URL(String(value || '')).hostname.toLowerCase();
    return DISCORD_ATTACHMENT_HOSTS.has(host) || host.endsWith('.discordapp.com') || host.endsWith('.discordapp.net');
  } catch (_) {
    return false;
  }
}

function classifyAttachment(attachment) {
  const name = String(attachment?.name || 'attachment').trim();
  const normalizedName = name.toLowerCase();
  const extension = extensionOf(normalizedName);
  const contentType = String(attachment?.contentType || '').split(';', 1)[0].trim().toLowerCase();
  const basenameWithoutFinalExtension = normalizedName.slice(0, Math.max(0, normalizedName.length - extension.length));
  const priorExtension = extensionOf(basenameWithoutFinalExtension);
  const findings = [];

  if (EXECUTABLE_EXTENSIONS.has(extension)) {
    findings.push({ category: 'executable', severity: 'critical', score: 85 });
  } else if (ACTIVE_CONTENT_EXTENSIONS.has(extension)) {
    const score = ['.svg', '.xml'].includes(extension) ? 45 : 65;
    findings.push({ category: 'active_content', severity: score >= 60 ? 'high' : 'medium', score });
  }
  if ((EXECUTABLE_EXTENSIONS.has(extension) || ACTIVE_CONTENT_EXTENSIONS.has(extension))
    && (IMAGE_EXTENSIONS.has(priorExtension) || priorExtension === '.pdf' || priorExtension === '.docx')) {
    findings.push({ category: 'double_extension', severity: 'critical', score: 90, disguisedAs: priorExtension });
  }
  if (ARCHIVE_EXTENSIONS.has(extension) && (EXECUTABLE_EXTENSIONS.has(priorExtension) || ACTIVE_CONTENT_EXTENSIONS.has(priorExtension))) {
    findings.push({ category: 'disguised_archive', severity: 'high', score: 70, disguisedAs: priorExtension });
  }
  if (IMAGE_EXTENSIONS.has(extension) && contentType && !IMAGE_CONTENT_TYPES.has(contentType)) {
    findings.push({ category: 'content_type_mismatch', severity: 'high', score: 60, declaredContentType: contentType });
  }
  return findings;
}

function isScannableImage(attachment) {
  const contentType = String(attachment?.contentType || '').split(';', 1)[0].trim().toLowerCase();
  return IMAGE_CONTENT_TYPES.has(contentType) && isDiscordAttachmentUrl(attachment?.url);
}

async function decodeQrImage(buffer) {
  const sharp = require('sharp');
  const jsQR = require('jsqr');
  const { data, info } = await sharp(buffer, { animated: false, limitInputPixels: 16000000 })
    .rotate()
    .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (!info?.width || !info?.height || info.channels !== 4) return null;
  const pixels = new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength);
  return jsQR(pixels, info.width, info.height, { inversionAttempts: 'attemptBoth' })?.data || null;
}

async function scanQrAttachment(attachment, options = {}) {
  if (!isScannableImage(attachment)) return null;
  const maxBytes = Math.max(1024, Math.min(8000000, Number(options.maxBytes) || 3000000));
  if (Number(attachment?.size) > maxBytes || activeQrScans >= MAX_CONCURRENT_QR_SCANS) return null;
  const timeoutMs = Math.max(1000, Math.min(10000, Number(options.timeoutMs) || 4000));
  const fetcher = options.fetcher || safeRemoteFetch;
  const decoder = options.decoder || decodeQrImage;
  activeQrScans += 1;
  try {
    const response = await fetcher(attachment.url, {
      maxBytes,
      timeoutMs,
      maxRedirects: 2,
      allowedContentTypes: [...IMAGE_CONTENT_TYPES]
    });
    if (!response?.ok || !response.body?.length) return null;
    const decoded = String(await decoder(response.body) || '').trim().slice(0, 2048);
    return decoded || null;
  } finally {
    activeQrScans -= 1;
  }
}

module.exports = {
  EXECUTABLE_EXTENSIONS,
  ACTIVE_CONTENT_EXTENSIONS,
  ARCHIVE_EXTENSIONS,
  IMAGE_CONTENT_TYPES,
  extensionOf,
  isDiscordAttachmentUrl,
  classifyAttachment,
  isScannableImage,
  decodeQrImage,
  scanQrAttachment
};
